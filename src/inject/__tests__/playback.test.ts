// What the player showed: WebCodecs decoders are counted, and the decoder stays native (ADR-49).
import { describe, expect, it } from 'vitest';
import { installPlayback, type PlaybackReport } from '../playback';

class FakeDecoder {
  static isConfigSupported(): string {
    return 'static-ok';
  }
  decodeQueueSize = 3;
  configured: unknown = null;
  constructor(private readonly init: { output: (frame: unknown) => void; error: (error: unknown) => void }) {}
  configure(config: unknown): void {
    this.configured = config;
  }
  decode(chunk: unknown): void {
    this.init.output({ chunk });
  }
  fail(): void {
    this.init.error(new Error('bad data'));
  }
}

function setup() {
  const scope: { VideoDecoder?: unknown; AudioDecoder?: unknown } = { VideoDecoder: FakeDecoder, AudioDecoder: FakeDecoder };
  let tick: () => void = () => undefined;
  const reports: PlaybackReport[] = [];
  installPlayback(scope as never, { now: () => 42, setInterval: (run) => (tick = run), report: (report) => reports.push(report) });
  return { scope, tick: () => tick(), reports };
}

describe('playback', () => {
  it('counts decoded frames and errors, keeps the codec, and the app still gets its frames', () => {
    const { scope, tick, reports } = setup();
    const got: unknown[] = [];
    const errors: unknown[] = [];
    const Video = scope.VideoDecoder as typeof FakeDecoder;
    const decoder = new Video({ output: (frame) => got.push(frame), error: (error) => errors.push(error) });
    expect(decoder).toBeInstanceOf(FakeDecoder);
    expect((Video as unknown as { isConfigSupported(): string }).isConfigSupported()).toBe('static-ok');
    decoder.configure({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 });
    expect(decoder.configured).toEqual({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 });
    decoder.decode(1);
    decoder.decode(2);
    decoder.fail();
    tick();
    expect(got).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(reports[0]).toMatchObject({ videoFrames: 2, audioFrames: 0, queue: 3, decoders: [{ kind: 'video', codec: 'avc1.64001f', width: 1280, height: 720 }] });
    expect(reports[0]?.events[0]).toMatchObject({ kind: 'decoder-error', text: 'VideoDecoder: bad data' });
    tick();
    expect(reports[1]?.videoFrames).toBe(0);
  });

  it('leaves a decoder with no callbacks to the native constructor', () => {
    const { scope } = setup();
    const Audio = scope.AudioDecoder as new (init?: unknown) => FakeDecoder;
    expect(() => new Audio({})).not.toThrow();
  });
});
