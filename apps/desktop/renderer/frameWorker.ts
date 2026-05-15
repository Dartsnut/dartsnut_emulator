type FrameJob = {
  width: number;
  height: number;
  rgbBase64: string;
  timestampMs: number;
};

type FrameResult = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  timestampMs: number;
};

type WorkerNack = { kind: "workerNack" };

type WorkerScope = {
  onmessage: ((event: MessageEvent<FrameJob>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const workerScope = self as unknown as WorkerScope;

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

workerScope.onmessage = async (event: MessageEvent<FrameJob>) => {
  const { width, height, rgbBase64, timestampMs } = event.data;
  const expectedRgb = width * height * 3;
  try {
    let rgb: Uint8Array;
    try {
      rgb = decodeBase64ToBytes(rgbBase64);
    } catch {
      workerScope.postMessage({ kind: "workerNack" } satisfies WorkerNack);
      return;
    }
    if (rgb.length !== expectedRgb) {
      workerScope.postMessage({ kind: "workerNack" } satisfies WorkerNack);
      return;
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
      rgba[dst] = rgb[src];
      rgba[dst + 1] = rgb[src + 1];
      rgba[dst + 2] = rgb[src + 2];
      rgba[dst + 3] = 255;
    }
    const imageData = new ImageData(rgba, width, height);
    const bitmap = await createImageBitmap(imageData);
    const result: FrameResult = { bitmap, width, height, timestampMs };
    workerScope.postMessage(result, [bitmap]);
  } catch {
    workerScope.postMessage({ kind: "workerNack" } satisfies WorkerNack);
  }
};
