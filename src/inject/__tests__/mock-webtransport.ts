// A WebTransport mock for tests. It acts like the native object:
// - state lives in private fields, so a getter called on a wrong receiver throws "Illegal invocation";
// - streams are real ReadableStreams (type 'bytes' by default).
// Tests drive the "network" through NativeSource and SessionControl.

type U8 = Uint8Array<ArrayBuffer>;
type Ctrl = { enqueue(chunk: U8): void; close(): void; error(reason?: unknown): void };

export type Bytes = number[] | Uint8Array | string;

export const toBytes = (data: Bytes): Uint8Array<ArrayBuffer> =>
  typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);

/** A readable stream that tests feed by hand. It is read-driven: pull() runs only when someone reads. */
export class NativeSource {
  readonly stream: ReadableStream<U8>;
  /** How many times the stream asked for data. One pull = one read by the consumer. */
  pulls = 0;
  /** How many chunks were handed to the consumer. */
  served = 0;
  cancelled = false;
  cancelReason: unknown = undefined;
  private ctrl: Ctrl | undefined;
  private queue: U8[] = [];
  private waiting = false;
  private closing = false;
  private ended = false;

  constructor(bytes = true) {
    const pull = (c: Ctrl): void => {
      this.pulls++;
      this.ctrl = c;
      this.waiting = true;
      this.serve();
    };
    const cancel = (reason: unknown): void => {
      this.cancelled = true;
      this.cancelReason = reason;
      this.ended = true;
    };
    this.stream = bytes
      ? new ReadableStream(
          {
            type: 'bytes',
            start: (c) => void (this.ctrl = c),
            pull: (c) => pull(c),
            cancel,
          },
          { highWaterMark: 0 },
        )
      : new ReadableStream<U8>(
          {
            start: (c) => void (this.ctrl = c),
            pull: (c) => pull(c),
            cancel,
          },
          { highWaterMark: 0 },
        );
  }

  private serve(): void {
    if (this.ended || !this.ctrl) return;
    if (this.waiting && this.queue.length > 0) {
      this.waiting = false;
      this.served++;
      this.ctrl.enqueue(this.queue.shift() as U8);
    }
    if (this.closing && this.queue.length === 0) {
      this.ended = true;
      this.ctrl.close();
    }
  }

  /** Queue a chunk. Each call makes a fresh buffer, so the transfer in enqueue() is safe. */
  push(...chunks: Bytes[]): this {
    for (const chunk of chunks) this.queue.push(toBytes(chunk));
    this.serve();
    return this;
  }

  /** Queue a chunk of length zero. Only works on non-byte streams: native byte streams reject it. */
  pushEmpty(): this {
    this.queue.push(new Uint8Array(0));
    this.serve();
    return this;
  }

  /** FIN: the stream closes after the queued chunks are read. */
  close(): void {
    this.closing = true;
    this.serve();
  }

  /** A native error. Reaches the consumer at once, even with chunks waiting. */
  error(reason: unknown): void {
    this.ended = true;
    this.ctrl?.error(reason);
  }
}

const illegal = (): never => {
  throw new TypeError('Illegal invocation');
};

export class MockDatagramDuplex {
  #source: NativeSource;
  #writable = new WritableStream<U8>();
  #incomingHighWaterMark = 1;

  constructor(source: NativeSource) {
    this.#source = source;
  }

  static #check(o: unknown): MockDatagramDuplex {
    return typeof o === 'object' && o !== null && #source in o ? (o as MockDatagramDuplex) : illegal();
  }

  get readable(): ReadableStream<U8> {
    return MockDatagramDuplex.#check(this).#source.stream;
  }
  get writable(): WritableStream<U8> {
    return MockDatagramDuplex.#check(this).#writable;
  }
  get incomingHighWaterMark(): number {
    return MockDatagramDuplex.#check(this).#incomingHighWaterMark;
  }
  set incomingHighWaterMark(value: number) {
    MockDatagramDuplex.#check(this).#incomingHighWaterMark = value;
  }
  get maxDatagramSize(): number {
    MockDatagramDuplex.#check(this);
    return 1200;
  }
  ping(): string {
    MockDatagramDuplex.#check(this);
    return 'pong-datagram';
  }
}

export class MockBidi {
  #source: NativeSource;
  #writable = new WritableStream<U8>();

  constructor(source: NativeSource) {
    this.#source = source;
  }

  static #check(o: unknown): MockBidi {
    return typeof o === 'object' && o !== null && #source in o ? (o as MockBidi) : illegal();
  }

  get readable(): ReadableStream<U8> {
    return MockBidi.#check(this).#source.stream;
  }
  get writable(): WritableStream<U8> {
    return MockBidi.#check(this).#writable;
  }
  ping(): string {
    MockBidi.#check(this);
    return 'pong-bidi';
  }
}

/** Control for a stream of streams (incomingUnidirectionalStreams and so on). */
export class IncomingControl<T> {
  readonly stream: ReadableStream<T>;
  pulls = 0;
  private ctrl!: ReadableStreamDefaultController<T>;

  constructor() {
    this.stream = new ReadableStream<T>({ start: (c) => void (this.ctrl = c) });
  }
  push(item: T): void {
    this.ctrl.enqueue(item);
  }
  close(): void {
    this.ctrl.close();
  }
}

export interface SessionControl {
  url: string;
  datagramSource: NativeSource;
  datagrams: MockDatagramDuplex;
  incomingUni: IncomingControl<ReadableStream<U8>>;
  incomingBidi: IncomingControl<MockBidi>;
  /** Bidi streams made by createBidirectionalStream(). */
  createdBidis: { bidi: MockBidi; source: NativeSource }[];
  /** Server opens a uni stream. */
  openUni(): NativeSource;
  /** Server opens a bidi stream. */
  openBidi(): { bidi: MockBidi; source: NativeSource };
  closeSession(): void;
  failSession(reason: unknown): void;
  rejectReady(reason: unknown): void;
}

export interface MockWebTransportKit {
  /** The "native" class. Install it on a fake scope. */
  Native: typeof WebTransport;
  /** One control for each instance made, in order. */
  sessions: SessionControl[];
}

/** Each call makes a new class, so tests do not share state. */
export function createMockWebTransport(): MockWebTransportKit {
  const sessions: SessionControl[] = [];

  class MockWebTransport {
    static supportsReliableOnly = true;
    static staticHelper(): string {
      return 'static-ok';
    }

    #ctl: SessionControl;
    #datagrams: MockDatagramDuplex;
    #ready: Promise<void>;
    #closed: Promise<unknown>;

    constructor(url: string | URL, _options?: unknown) {
      void _options;
      const datagramSource = new NativeSource(true);
      const incomingUni = new IncomingControl<ReadableStream<U8>>();
      const incomingBidi = new IncomingControl<MockBidi>();
      let resolveReady!: () => void;
      let rejectReady!: (r: unknown) => void;
      let resolveClosed!: (v: unknown) => void;
      let rejectClosed!: (r: unknown) => void;
      this.#ready = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });
      this.#closed = new Promise<unknown>((res, rej) => {
        resolveClosed = res;
        rejectClosed = rej;
      });
      resolveReady();
      const datagrams = new MockDatagramDuplex(datagramSource);
      this.#datagrams = datagrams;
      this.#ctl = {
        url: String(url),
        datagramSource,
        datagrams,
        incomingUni,
        incomingBidi,
        createdBidis: [],
        openUni() {
          const source = new NativeSource(true);
          incomingUni.push(source.stream);
          return source;
        },
        openBidi() {
          const source = new NativeSource(true);
          const bidi = new MockBidi(source);
          incomingBidi.push(bidi);
          return { bidi, source };
        },
        closeSession: () => resolveClosed({ closeCode: 0, reason: '' }),
        failSession: (r) => rejectClosed(r),
        rejectReady: (r) => rejectReady(r),
      };
      sessions.push(this.#ctl);
    }

    static #check(o: unknown): MockWebTransport {
      return typeof o === 'object' && o !== null && #ctl in o ? (o as MockWebTransport) : illegal();
    }

    get datagrams(): MockDatagramDuplex {
      return MockWebTransport.#check(this).#datagrams;
    }
    get incomingUnidirectionalStreams(): ReadableStream {
      return MockWebTransport.#check(this).#ctl.incomingUni.stream;
    }
    get incomingBidirectionalStreams(): ReadableStream {
      return MockWebTransport.#check(this).#ctl.incomingBidi.stream;
    }
    get ready(): Promise<void> {
      return MockWebTransport.#check(this).#ready;
    }
    get closed(): Promise<unknown> {
      return MockWebTransport.#check(this).#closed;
    }
    get reliability(): string {
      MockWebTransport.#check(this);
      return 'supports-unreliable';
    }
    close(): void {
      MockWebTransport.#check(this).#ctl.closeSession();
    }
    getStats(): Promise<{ bytesSent: number }> {
      MockWebTransport.#check(this);
      return Promise.resolve({ bytesSent: 42 });
    }
    async createBidirectionalStream(): Promise<MockBidi> {
      const self = MockWebTransport.#check(this);
      const source = new NativeSource(true);
      const bidi = new MockBidi(source);
      self.#ctl.createdBidis.push({ bidi, source });
      return bidi;
    }
  }

  return { Native: MockWebTransport as unknown as typeof WebTransport, sessions };
}
