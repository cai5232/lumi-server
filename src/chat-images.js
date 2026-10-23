import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Conversation attachments are independent of optional gallery collection.
// Store each image once; threads and cache snapshots contain only references.
export async function saveChatImages(dataDir, images) {
  if (!images?.length) return [];
  const directory = join(dataDir, 'chat-images');
  await mkdir(directory, { recursive: true });
  return Promise.all(images.map(async image => {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(image)) {
      throw new Error('invalid_chat_image');
    }
    const id = createHash('sha256').update(image).digest('hex');
    const temporaryPath = join(directory, id + '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temporaryPath, image, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, join(directory, id));
    } finally { await unlink(temporaryPath).catch(() => {}); }
    return id;
  }));
}

export async function loadChatImages(dataDir, ids = []) {
  const images = await Promise.all(ids.slice(0, 4).map(async id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
    try { return await readFile(join(dataDir, 'chat-images', id), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return images.filter(Boolean);
}
