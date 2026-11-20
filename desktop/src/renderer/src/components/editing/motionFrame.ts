import type { MotionScene } from '@emperor/core/editing'
import { desktopMotionFrame } from '../../api/backend'

export function renderMotionFrame(
  scene: MotionScene,
  frame: number,
  width = 640,
): Promise<string> {
  // Vue proxies cannot cross Electron's structured-clone boundary. The project
  // schema stores only JSON, including objects nested inside a reactive scene.
  return desktopMotionFrame(JSON.parse(JSON.stringify(scene)), frame, width)
}
