/** Downsample little-endian signed 16-bit PCM into normalized peak buckets. */
export function downsamplePcm(buffer: Buffer, buckets = 400): number[] {
  if (buckets <= 0 || buffer.length < 2) return []
  const samples = Math.floor(buffer.length / 2)
  const size = Math.max(1, Math.floor(samples / buckets))
  const peaks: number[] = []
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = bucket * size
    if (from >= samples) break
    const to = Math.min(samples, from + size)
    let peak = 0
    for (let index = from; index < to; index += 1) {
      const value = Math.abs(buffer.readInt16LE(index * 2)) / 32_768
      if (value > peak) peak = value
    }
    peaks.push(Math.min(1, Math.round(peak * 1000) / 1000))
  }
  return peaks
}

/** Aggregate a complete PCM stream without retaining decoded audio in memory. */
export function collectPcmPeaks(expectedSamples: number, buckets = 400) {
  const width = Math.max(1, Math.ceil(expectedSamples / buckets))
  const peaks = Array.from({ length: buckets }, () => 0)
  let sampleIndex = 0
  let lowByte: number | undefined

  function add(sample: number): void {
    const bucket = Math.min(peaks.length - 1, Math.floor(sampleIndex / width))
    peaks[bucket] = Math.max(peaks[bucket]!, Math.abs(sample))
    sampleIndex += 1
  }

  return {
    push(buffer: Buffer): void {
      if (!buffer.length) return
      let offset = 0
      if (lowByte !== undefined) {
        add(lowByte | (buffer.readInt8(0) << 8))
        lowByte = undefined
        offset = 1
      }
      for (; offset + 1 < buffer.length; offset += 2)
        add(buffer.readInt16LE(offset))
      if (offset < buffer.length) lowByte = buffer[offset]
    },
    values(): number[] {
      return sampleIndex
        ? peaks.map((peak) => Math.round((peak / 32_768) * 1000) / 1000)
        : []
    },
  }
}
