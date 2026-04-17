type GlobalKey = string | symbol;

type GlobalMutation = {
  key: GlobalKey;
  before: PropertyDescriptor | undefined;
  after: PropertyDescriptor | undefined;
};

function cloneDescriptor(descriptor: PropertyDescriptor | undefined): PropertyDescriptor | undefined {
  if (!descriptor) {
    return undefined;
  }

  return { ...descriptor };
}

function captureGlobalDescriptors() {
  const descriptors = new Map<GlobalKey, PropertyDescriptor | undefined>();
  for (const key of Reflect.ownKeys(globalThis)) {
    descriptors.set(key, cloneDescriptor(Object.getOwnPropertyDescriptor(globalThis, key)));
  }
  return descriptors;
}

function descriptorsEqual(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return left === right;
  }

  return left.configurable === right.configurable
    && left.enumerable === right.enumerable
    && left.writable === right.writable
    && left.value === right.value
    && left.get === right.get
    && left.set === right.set;
}

function applyDescriptor(key: GlobalKey, descriptor: PropertyDescriptor | undefined) {
  try {
    if (!descriptor) {
      delete (globalThis as Record<GlobalKey, unknown>)[key];
      return;
    }

    Object.defineProperty(globalThis, key, descriptor);
  } catch {
    // Ignore globals that cannot be restored cleanly.
  }
}

export class GlobalMutationTracker {
  private released = false;

  constructor(
    private readonly mutations: GlobalMutation[],
  ) {}

  static async capture<T>(action: () => Promise<T> | T) {
    const before = captureGlobalDescriptors();
    const result = await action();
    const after = captureGlobalDescriptors();
    const orderedKeys = [...before.keys(), ...after.keys()];
    const seenKeys = new Set<GlobalKey>();
    const mutations: GlobalMutation[] = [];

    for (const key of orderedKeys) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      const beforeDescriptor = before.get(key);
      const afterDescriptor = after.get(key);
      if (descriptorsEqual(beforeDescriptor, afterDescriptor)) {
        continue;
      }

      mutations.push({
        key,
        before: beforeDescriptor,
        after: afterDescriptor,
      });
    }

    return {
      result,
      tracker: new GlobalMutationTracker(mutations),
    };
  }

  merge(other: GlobalMutationTracker) {
    if (this.mutations.length === 0) {
      return other;
    }
    if (other.mutations.length === 0) {
      return this;
    }

    const merged = new Map<GlobalKey, GlobalMutation>();
    for (const mutation of this.mutations) {
      merged.set(mutation.key, { ...mutation });
    }
    for (const mutation of other.mutations) {
      const existing = merged.get(mutation.key);
      merged.set(mutation.key, {
        key: mutation.key,
        before: existing?.before ?? mutation.before,
        after: mutation.after,
      });
    }

    const orderedKeys = [...this.mutations.map((mutation) => mutation.key), ...other.mutations.map((mutation) => mutation.key)];
    const seenKeys = new Set<GlobalKey>();
    const combined: GlobalMutation[] = [];

    for (const key of orderedKeys) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      const mutation = merged.get(key);
      if (mutation) {
        combined.push(mutation);
      }
    }

    return new GlobalMutationTracker(combined);
  }

  release() {
    if (this.released) {
      return;
    }

    for (let index = this.mutations.length - 1; index >= 0; index -= 1) {
      const mutation = this.mutations[index];
      if (!mutation) {
        continue;
      }
      applyDescriptor(mutation.key, mutation.before);
    }

    this.released = true;
  }

  reapply() {
    if (!this.released) {
      return;
    }

    for (const mutation of this.mutations) {
      applyDescriptor(mutation.key, mutation.after);
    }

    this.released = false;
  }
}
