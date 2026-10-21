import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_IMAGE_BYTES = 2_500_000;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"]
]);

function detectedMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function createStickerStore(dataDir) {
  const imageDir = join(dataDir, "stickers");
  const catalogPath = join(dataDir, "stickers.json");

  async function readCatalog() {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      return {
        categories: Array.isArray(catalog.categories) ? catalog.categories.filter((item) => typeof item === "string") : [],
        stickers: Array.isArray(catalog.stickers) ? catalog.stickers : []
      };
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`[stickers] catalog unavailable: ${error.message}`);
      return { categories: [], stickers: [] };
    }
  }

  async function writeCatalog(catalog) {
    await mkdir(dataDir, { recursive: true });
    const temporaryPath = `${catalogPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(catalog, null, 2), { mode: 0o600 });
    await rename(temporaryPath, catalogPath);
  }

  return {
    async list() {
      const catalog = await readCatalog();
      const stickers = catalog.stickers.filter((item) => item && typeof item.id === "string" && typeof item.image === "string");
      return { categories: catalog.categories, stickers };
    },

    async add(input) {
      const name = String(input?.name || "").trim().slice(0, 80);
      const category = String(input?.category || "").trim().slice(0, 40);
      const match = String(input?.dataURL || "").match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+=*)$/i);
      if (!name || !category || !match) {
        const error = new Error("贴纸需要名称、分类和 JPEG、PNG、GIF 或 WebP 图片");
        error.statusCode = 400;
        throw error;
      }
      const mimeType = match[1].toLowerCase();
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || detectedMime(bytes) !== mimeType) {
        const error = new Error("贴纸图片格式不正确或超过 2.5 MB");
        error.statusCode = 400;
        throw error;
      }
      await mkdir(imageDir, { recursive: true });
      const id = randomUUID();
      const extension = MIME_EXTENSIONS.get(mimeType);
      const filename = `${id}.${extension}`;
      await writeFile(join(imageDir, filename), bytes, { flag: "wx", mode: 0o600 });
      const catalog = await readCatalog();
      const sticker = { id, name, category, image: `/v1/stickers/assets/${filename}`, mimeType, createdAt: new Date().toISOString() };
      catalog.stickers.push(sticker);
      if (!catalog.categories.includes(category)) catalog.categories.push(category);
      try {
        await writeCatalog(catalog);
      } catch (error) {
        await unlink(join(imageDir, filename)).catch(() => {});
        throw error;
      }
      return sticker;
    },

    async remove(id) {
      const catalog = await readCatalog();
      const index = catalog.stickers.findIndex((item) => item?.id === id);
      if (index < 0) return false;
      const [sticker] = catalog.stickers.splice(index, 1);
      const usedCategories = new Set(catalog.stickers.map((item) => item.category));
      catalog.categories = catalog.categories.filter((category) => usedCategories.has(category));
      await writeCatalog(catalog);
      const filename = String(sticker.image || "").split("/").at(-1);
      if (/^[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/i.test(filename)) await unlink(join(imageDir, filename)).catch(() => {});
      return true;
    },

    async image(filename) {
      if (!/^[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/i.test(filename)) return null;
      try {
        const bytes = await readFile(join(imageDir, filename));
        const mimeType = detectedMime(bytes);
        return mimeType ? { bytes, mimeType } : null;
      } catch { return null; }
    }
  };
}

// Keep captions and names separate: older clients append a marker to the caption.
export function stickerMessageForModel(input, catalogSticker = null) {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const marker = content.match(/\[表情[:：]\s*([^\r\n]+)\]\s*$/);
  const cleanName = value => typeof value === "string" ? value.trim().slice(0, 80) : "";
  const name = cleanName(input.stickerName) || cleanName(catalogSticker?.name) || cleanName(marker?.[1]);
  const caption = marker ? content.replace(marker[0], "").trim() : content;
  return [caption, name ? `[用户发送了贴纸「${name}」]` : "[用户发送了一张贴纸，未提供名称]"].filter(Boolean).join("\n");
}

const stickerReplyMarker = /\[发送表情[:：]\s*([^\]\r\n]+)\]/g;
function availableStickers(stickers) {
  return stickers.filter(sticker => sticker && /^[0-9a-f-]{36}$/i.test(sticker.id) && /^\/v1\/stickers\/assets\/[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/i.test(sticker.image) && typeof sticker.name === 'string').slice(0, 200);
}

export function sharedStickerContext(stickers) {
  const available = availableStickers(stickers);
  if (!available.length) return '';
  return '\n\n[共享表情包库]\n下面是用户与你共用的贴纸，名称是用户的文字描述，不代表你看过图片。你可以在适合时选用一张，也可以只发贴纸；不必每条回复都发。选用时在回复末尾单独写 [发送表情:编号]，可在标记前写正常配文。只允许使用下列编号，不要编造编号或图片链接。\n' + JSON.stringify(available.map(({id,name})=>({id,name}))) + '\n[/共享表情包库]';
}

export function extractStickerReply(content, stickers) {
  const available = availableStickers(stickers);
  let selected = null;
  const text = String(content || '').replace(stickerReplyMarker, (_, id) => {
    selected ||= available.find(sticker => sticker.id === id.trim()) || null;
    return '';
  }).trim();
  return {content: text, sticker: selected};
}
