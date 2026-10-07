/**
 * Wrap an async frame handler so frames are handled one at a time, in arrival order.
 *
 * WebSocket `onmessage` does not wait for an async handler. The phone sends its plain `hello`
 * and then, as soon as the user taps Connect, a sealed `ready`. If the handler for `hello` is
 * still deriving the session key when `ready` arrives, a naive handler sees no key yet and drops
 * `ready`, so pairing never finishes. Chaining every frame onto one promise fixes that.
 */
export function inOrder<T>(handle: (frame: T) => Promise<void> | void, onError?: (e: unknown) => void) {
  let queue: Promise<void> = Promise.resolve();
  return (frame: T): Promise<void> => {
    queue = queue.then(() => handle(frame)).catch((e) => onError?.(e));
    return queue;
  };
}
