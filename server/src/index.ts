import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import express from 'express'
import multer from 'multer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const upload = multer({ storage: multer.memoryStorage() })

const PORT = Number(process.env.PORT ?? 18743)

type PythonCommand = {
  bin: string
  args: string[]
}

function dedupePythonCommands(commands: PythonCommand[]): PythonCommand[] {
  const seen = new Set<string>()
  const out: PythonCommand[] = []
  for (const cmd of commands) {
    const key = `${cmd.bin}::${cmd.args.join(' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cmd)
  }
  return out
}

function resolveWithWhere(names: string[]): string[] {
  const resolved: string[] = []
  for (const name of names) {
    const probe = spawnSync('where.exe', [name], { encoding: 'utf8', shell: false })
    if (probe.status !== 0 || !probe.stdout) continue
    const lines = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    resolved.push(...lines)
  }
  return resolved
}

function buildPythonCandidates(): PythonCommand[] {
  const explicit = process.env.VORA_PYTHON?.trim()
  if (explicit) return [{ bin: explicit, args: [] }]

  if (process.platform !== 'win32') {
    return [{ bin: 'python3', args: [] }, { bin: 'python', args: [] }]
  }

  const out: PythonCommand[] = [{ bin: 'py', args: ['-3'] }, { bin: 'python', args: [] }, { bin: 'python3', args: [] }]

  const launcherPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'py.exe')
  if (fs.existsSync(launcherPath)) {
    out.unshift({ bin: launcherPath, args: ['-3'] })
  }

  const wherePaths = resolveWithWhere(['py', 'python', 'python3'])
  for (const p of wherePaths) {
    const file = p.toLowerCase()
    if (file.endsWith('py.exe')) {
      out.push({ bin: p, args: ['-3'] })
      continue
    }
    out.push({ bin: p, args: [] })
  }

  const commonRoots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
  const versions = ['313', '312', '311', '310', '39']
  for (const root of commonRoots) {
    for (const ver of versions) {
      const candidate = path.join(root, 'Programs', 'Python', `Python${ver}`, 'python.exe')
      if (fs.existsSync(candidate)) out.push({ bin: candidate, args: [] })
      const alt = path.join(root, `Python${ver}`, 'python.exe')
      if (fs.existsSync(alt)) out.push({ bin: alt, args: [] })
    }
  }

  return dedupePythonCommands(out)
}

const PYTHON_CANDIDATES = buildPythonCandidates()
const WORKER_TIMEOUT_MS = Number(process.env.VORA_WORKER_TIMEOUT_MS ?? 120000)
const WORKER_BOOT_TIMEOUT_MS = Number(process.env.VORA_BOOT_TIMEOUT_MS ?? 600000)
const WORKER_SCRIPT = path.resolve(__dirname, '../python/lama_worker.py')

type WorkerRequest = {
  resolve: (value: Buffer) => void
  reject: (reason?: unknown) => void
  timer: NodeJS.Timeout
}

class LamaWorkerClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, WorkerRequest>()
  private stdoutBuf = ''
  private ready = false
  private device: string | null = null
  private requestedDevice: 'auto' | 'cpu' | 'cuda' = ((): 'auto' | 'cpu' | 'cuda' => {
    const raw = (process.env.VORA_DEVICE ?? 'auto').toLowerCase().trim()
    return raw === 'cpu' || raw === 'cuda' ? raw : 'auto'
  })()
  private cudaAvailable: boolean | null = null
  private initPromise: Promise<void> | null = null
  private lastError: string | null = null
  private warning: string | null = null
  private modelName: string | null = null
  private samModelName: string | null = null
  private samBackendName: string | null = null
  private lamaFp16: boolean | null = null

  private decodeBase64ToBuffer(value: string): Buffer {
    return Buffer.from(value, 'base64')
  }

  private encodeBufferToBase64(value: Buffer): string {
    return value.toString('base64')
  }

  private clearAllPending(err: Error) {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  private normalizeDevice(raw: string): 'auto' | 'cpu' | 'cuda' {
    const value = raw.toLowerCase().trim()
    if (value === 'cpu' || value === 'cuda') return value
    return 'auto'
  }

  private stopWorker() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    this.proc = null
    this.ready = false
    this.initPromise = null
  }

  private handleStdoutChunk(chunk: Buffer) {
    this.stdoutBuf += chunk.toString('utf8')
    while (true) {
      const idx = this.stdoutBuf.indexOf('\n')
      if (idx < 0) break
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (!line) continue

      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        if (msg.type === 'ready') {
          this.device = typeof msg.device === 'string' ? msg.device : null
          this.requestedDevice = this.normalizeDevice(typeof msg.requested_device === 'string' ? msg.requested_device : this.requestedDevice)
          this.cudaAvailable = typeof msg.cuda_available === 'boolean' ? msg.cuda_available : this.cudaAvailable
          this.warning = typeof msg.warning === 'string' ? msg.warning : null
          this.modelName = typeof msg.model === 'string' ? msg.model : this.modelName
          this.samModelName = typeof msg.sam_model === 'string' ? msg.sam_model : this.samModelName
          this.samBackendName = typeof msg.sam_backend === 'string' ? msg.sam_backend : this.samBackendName
          this.lamaFp16 = typeof msg.lama_fp16 === 'boolean' ? msg.lama_fp16 : this.lamaFp16
          if (this.warning) {
            // eslint-disable-next-line no-console
            console.warn(`[lama-worker warning] ${this.warning}`)
          }
          this.ready = true
          this.lastError = null
          return
        }

        const id = typeof msg.id === 'string' ? msg.id : null
        if (!id) continue
        const pending = this.pending.get(id)
        if (!pending) continue
        this.pending.delete(id)
        clearTimeout(pending.timer)

        if (msg.ok === true) {
          const outputB64 = msg.output_b64
          if (typeof outputB64 !== 'string') {
            pending.reject(new Error('Worker response missing output_b64'))
            continue
          }
          pending.resolve(this.decodeBase64ToBuffer(outputB64))
          continue
        }

        const errorMsg = typeof msg.error === 'string' ? msg.error : 'Unknown worker error'
        pending.reject(new Error(errorMsg))
      } catch (e) {
        this.clearAllPending(new Error(`Invalid worker output: ${String(e)}`))
      }
    }
  }

  private async spawnWorker(): Promise<void> {
    let lastErr: unknown = null
    const attempted: string[] = []

    for (const py of PYTHON_CANDIDATES) {
      try {
        this.ready = false
        attempted.push([py.bin, ...py.args].join(' '))
        const proc = spawn(py.bin, [...py.args, WORKER_SCRIPT], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VORA_DEVICE: this.requestedDevice,
          },
          shell: false,
        })

        let startupErr = ''
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            const detail = startupErr.trim()
            reject(new Error(detail ? `Worker startup timeout: ${detail}` : 'Worker startup timeout'))
          }, WORKER_BOOT_TIMEOUT_MS)

          const settle = (err?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (err) reject(err)
            else resolve()
          }

          const onError = (err: Error) => settle(err)
          const onData = (chunk: Buffer) => {
            this.handleStdoutChunk(chunk)
            if (this.ready) settle()
          }
          const onStderr = (chunk: Buffer) => {
            const msg = chunk.toString('utf8').trim()
            if (!msg) return
            startupErr = startupErr ? `${startupErr}\n${msg}` : msg
            // eslint-disable-next-line no-console
            console.error(`[lama-worker stderr] ${msg}`)
          }
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            if (this.ready) return
            const detail = startupErr.trim()
            const reason = `Worker exited before ready (code=${String(code)}, signal=${signal ?? 'none'})`
            settle(new Error(detail ? `${reason}: ${detail}` : reason))
          }

          proc.once('error', onError)
          proc.once('exit', onExit)
          proc.stdout.on('data', onData)
          proc.stderr.on('data', onStderr)
        })

        proc.on('exit', () => {
          this.proc = null
          this.ready = false
          this.initPromise = null
          this.lastError = 'LaMa worker exited unexpectedly'
          this.clearAllPending(new Error('LaMa worker exited unexpectedly'))
        })

        this.proc = proc
        return
      } catch (e) {
        lastErr = e
        this.ready = false
        this.lastError = String(e instanceof Error ? e.message : e)
      }
    }

    throw new Error(`Failed to start LaMa worker: ${String(lastErr)} (attempted: ${attempted.join(' | ')})`)
  }

  async ensureReady(): Promise<void> {
    if (this.proc && this.ready) return
    if (!this.initPromise) {
      this.initPromise = this.spawnWorker().finally(() => {
        this.initPromise = null
      })
    }
    await this.initPromise
  }

  async inpaint(image: Buffer, mask: Buffer): Promise<Buffer> {
    await this.ensureReady()
    if (!this.proc) throw new Error('LaMa worker not running')

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const payload = {
      id,
      op: 'inpaint',
      image_b64: this.encodeBufferToBase64(image),
      mask_b64: this.encodeBufferToBase64(mask),
    }

    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LaMa worker timeout after ${WORKER_TIMEOUT_MS}ms`))
      }, WORKER_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.proc?.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  async segmentPoint(image: Buffer, pointX: number, pointY: number): Promise<Buffer> {
    await this.ensureReady()
    if (!this.proc) throw new Error('LaMa worker not running')

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const payload = {
      id,
      op: 'segment_point',
      image_b64: this.encodeBufferToBase64(image),
      point_x: Math.round(pointX),
      point_y: Math.round(pointY),
    }

    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LaMa worker timeout after ${WORKER_TIMEOUT_MS}ms`))
      }, WORKER_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        this.proc?.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  getDevice(): string | null {
    return this.device
  }

  getRequestedDevice(): 'auto' | 'cpu' | 'cuda' {
    return this.requestedDevice
  }

  getCudaAvailable(): boolean | null {
    return this.cudaAvailable
  }

  getLastError(): string | null {
    return this.lastError
  }

  getWarning(): string | null {
    return this.warning
  }

  getModelName(): string | null {
    return this.modelName
  }

  getSamModelName(): string | null {
    return this.samModelName
  }

  getSamBackendName(): string | null {
    return this.samBackendName
  }

  getLamaFp16(): boolean | null {
    return this.lamaFp16
  }

  isReady(): boolean {
    return this.ready
  }

  async setRequestedDevice(next: 'cpu' | 'cuda'): Promise<void> {
    if (this.requestedDevice === next && this.ready) return
    this.requestedDevice = next
    this.warning = null
    this.lastError = null
    this.stopWorker()
    await this.ensureReady()
  }
}

const lamaWorker = new LamaWorkerClient()

function healthPayload() {
  return {
    status: 'ok',
    worker: {
      model: lamaWorker.getModelName() ?? 'big-lama',
      samModel: lamaWorker.getSamModelName() ?? 'facebook/sam-vit-large',
      samBackend: lamaWorker.getSamBackendName() ?? 'sam_vit',
      lamaFp16: lamaWorker.getLamaFp16(),
      ready: lamaWorker.isReady(),
      device: lamaWorker.getDevice() ?? 'initializing',
      requestedDevice: lamaWorker.getRequestedDevice(),
      cudaAvailable: lamaWorker.getCudaAvailable(),
      error: lamaWorker.getLastError(),
      warning: lamaWorker.getWarning(),
    },
  }
}

app.get('/health', (_req, res) => {
  if (!lamaWorker.isReady()) {
    res.status(503).json({
      ...healthPayload(),
      error: 'Worker initializing',
    })
    return
  }
  res.json(healthPayload())
})

app.get('/api/health', (_req, res) => {
  if (!lamaWorker.isReady()) {
    lamaWorker.ensureReady().catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`[lama-worker] health retry failed: ${String(e)}`)
    })
    res.status(503).json({
      ...healthPayload(),
      error: 'Worker initializing',
    })
    return
  }
  res.json(healthPayload())
})

app.use(express.json())

app.post('/api/device', async (req, res) => {
  const requested = typeof req.body?.device === 'string' ? req.body.device : ''
  if (requested !== 'cpu' && requested !== 'cuda') {
    res.status(400).json({ error: 'device must be cpu or cuda' })
    return
  }

  if (requested === 'cuda' && lamaWorker.getCudaAvailable() === false) {
    res.status(409).json({ error: 'CUDA is not available on this environment' })
    return
  }

  try {
    await lamaWorker.setRequestedDevice(requested)
    res.json(healthPayload())
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) })
  }
})

async function runLamaInpaint(image: Buffer, mask: Buffer): Promise<Buffer> {
  return await lamaWorker.inpaint(image, mask)
}

async function runSamSegmentPoint(image: Buffer, pointX: number, pointY: number): Promise<Buffer> {
  return await lamaWorker.segmentPoint(image, pointX, pointY)
}

app.post('/api/inpaint', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mask', maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const imageFile = files?.image?.[0]
    const maskFile = files?.mask?.[0]

    if (!imageFile || !maskFile) {
      res.status(400).json({ error: 'Missing image or mask' })
      return
    }

    const out = await runLamaInpaint(imageFile.buffer, maskFile.buffer)
    res.setHeader('content-type', 'image/png')
    res.send(out)
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e)
    if (message.includes('ENOENT')) {
      res.status(500).json({ error: 'Python executable not found. Install Python 3.10+ and ensure `py` or `python` is available in PATH.' })
      return
    }
    if (message.includes('No module named')) {
      res.status(500).json({ error: 'LaMa dependencies are missing. Install required packages (simple-lama-inpainting, pillow, numpy).' })
      return
    }
    res.status(500).json({ error: message })
  }
})

app.post('/api/segment-point', upload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  const startedAt = Date.now()
  const reqId = `seg_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(`[segment-point] start id=${reqId} body=${JSON.stringify({ contentLength: req.headers['content-length'] })}`)
  }
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const imageFile = files?.image?.[0]
    const pointXRaw = Number(req.body?.pointX)
    const pointYRaw = Number(req.body?.pointY)

    if (!imageFile || !Number.isFinite(pointXRaw) || !Number.isFinite(pointYRaw)) {
      res.status(400).json({ error: 'Missing image or pointX/pointY' })
      return
    }

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(
        `[segment-point] request id=${reqId} point=(${Math.round(pointXRaw)}, ${Math.round(pointYRaw)}) imageSize=${imageFile.size}`,
      )
    }

    const out = await runSamSegmentPoint(imageFile.buffer, pointXRaw, pointYRaw)
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(`[segment-point] done id=${reqId} durationMs=${Date.now() - startedAt} outputSize=${out.length}`)
    }
    res.setHeader('content-type', 'image/png')
    res.send(out)
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e)
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error(`[segment-point] error id=${reqId} durationMs=${Date.now() - startedAt} message=${message}`)
    }
    if (message.includes('No module named')) {
      res.status(500).json({ error: 'SAM dependencies are missing. Install required packages (sam2 or transformers, hydra-core, iopath, omegaconf, torch, torchvision, numpy, pillow).' })
      return
    }
    res.status(500).json({ error: message })
  }
})

const webDist = path.resolve(__dirname, '../../web/dist')
app.use(express.static(webDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'))
})

async function startServer() {
  try {
    await lamaWorker.ensureReady()
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Vora AI server listening on http://localhost:${PORT}`)
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Failed to initialize LaMa worker before startup: ${String(e)}`)
    process.exit(1)
  }
}

void startServer()
