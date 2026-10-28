type MermaidRenderTask = () => Promise<void>

const pending = new Set<MermaidRenderTask>()
let running = false

async function drainRenders(): Promise<void> {
  running = true
  try {
    while (pending.size > 0) {
      const next = pending.values().next().value
      if (!next) {
        break
      }
      pending.delete(next)
      try {
        await next()
      } catch {
        // Each diagram owns its error display; a failed task must not strand other diagrams.
      }
    }
  } finally {
    running = false
  }
}

// Serialize global parser state while letting abandoned diagrams release queued source immediately.
export function enqueueMermaidRender(task: MermaidRenderTask): () => void {
  pending.add(task)
  if (!running) {
    void drainRenders()
  }
  return () => {
    pending.delete(task)
  }
}
