import { describe, expect, it, vi } from 'vitest'
import { withFilterGraphFile } from './media-process'

describe('FFmpeg filter graph file options', () => {
  it('uses the current spelling and falls back if the binary rejects it', async () => {
    const render = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Unrecognized option '/filter_complex'.\nError splitting the argument list: Option not found",
        ),
      )
      .mockResolvedValueOnce('rendered')
    await expect(withFilterGraphFile(render)).resolves.toBe('rendered')
    expect(render.mock.calls).toEqual([
      ['-/filter_complex'],
      ['-filter_complex_script'],
    ])
  })

  it('reports a rendering failure without starting another encode', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Error encoding video'))
    await expect(withFilterGraphFile(render)).rejects.toThrow(
      'Error encoding video',
    )
    expect(render).toHaveBeenCalledTimes(1)
  })
})
