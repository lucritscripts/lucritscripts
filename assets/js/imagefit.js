// Shrinks an uploaded image so it always fits — on the server and on screen.
//
// The thumbnail bug, in one line: the form accepted images up to 3 MB, and the
// server only accepts ~300 KB. Any normal screenshot passed the form, failed
// the publish, and the publisher was told their image "isn't a supported
// image". Now the browser resizes and re-encodes first, so whatever someone
// picks — PNG, JPEG, WebP, GIF, AVIF, a 4K screenshot, a phone photo — arrives
// as a compact WebP (or JPEG where WebP encoding isn't available) under the
// limit, with its shape preserved.

const TARGET_CHARS = 380000;   // data-URL length; the server's cap is 420 000

function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
    img.src = url;
  });
}

/**
 * @returns {Promise<{dataUrl:string,width:number,height:number,srcWidth:number,srcHeight:number}>}
 */
export async function fitImage(file, { maxSide = 1280 } = {}) {
  const img = await loadBitmap(file);
  const srcWidth = img.naturalWidth || img.width;
  const srcHeight = img.naturalHeight || img.height;
  if (!srcWidth || !srcHeight) throw new Error("unreadable");

  let scale = Math.min(1, maxSide / Math.max(srcWidth, srcHeight));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  for (let pass = 0; pass < 6; pass++) {
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));
    canvas.width = w; canvas.height = h;
    ctx.imageSmoothingQuality = "high";
    // A dark fill behind transparent images, so a JPEG fallback doesn't turn
    // transparency black-on-black in an ugly way.
    ctx.fillStyle = "#0b0f19";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    for (const q of [0.86, 0.78, 0.68, 0.58]) {
      let url = canvas.toDataURL("image/webp", q);
      if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= TARGET_CHARS) {
        img.close?.();
        return { dataUrl: url, width: w, height: h, srcWidth, srcHeight };
      }
    }
    scale *= 0.75;
  }
  img.close?.();
  throw new Error("too-large");
}
