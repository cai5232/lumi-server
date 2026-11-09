export class MemoryStateStore {
  #states = new Map();

  async load(id) {
    const value = this.#states.get(id);
    return value ? structuredClone(value) : null;
  }

  async save(id, state) {
    this.#states.set(id, structuredClone(state));
  }

  async delete(id) {
    this.#states.delete(id);
  }
}
