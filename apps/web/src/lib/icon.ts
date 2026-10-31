/** Center-crop an image file to a square PNG at the given side, returned as a base64 string (no data: prefix).
 *  Shared by every entity's icon upload (app/project/team/database) so cropping/encoding is identical. */
export async function cropToPngBase64(file: File, side: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    const crop = Math.min(img.width, img.height);
    if (!crop) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no-canvas");
    ctx.imageSmoothingQuality = "high"; // the default "low" aliases badly downscaling a large photo to 128px
    ctx.drawImage(img, (img.width - crop) / 2, (img.height - crop) / 2, crop, crop, 0, 0, side, side);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("encode");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } finally {
    URL.revokeObjectURL(url);
  }
}
