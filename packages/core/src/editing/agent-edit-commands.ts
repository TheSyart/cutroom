import { z } from 'zod'
import { videoProjectCommandSchema } from './types'

// Authored code takes the incremental, sandbox-preflight path rather than a raw batch.
export const agentEditCommandSchema = z.union(
  videoProjectCommandSchema.options.filter(
    (schema) => schema.shape.type.value !== 'upsertMotionScene',
  ),
)
