/**
 * An iframe removed during navigation may never dispatch load. Reject that
 * navigation so the engine's actual work queue can settle and release its book.
 * Used by the checked build transform of the pinned Foliate renderers.
 */
export function loadFoliateFrame<T>(frame: HTMLIFrameElement, src: string, onLoad: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!frame.isConnected) {
      reject(new DOMException('Reader frame was detached', 'AbortError'));
      return;
    }
    const observer = new MutationObserver(() => {
      if (!frame.isConnected) fail(new DOMException('Reader frame was detached', 'AbortError'));
    });
    const cleanup = () => {
      observer.disconnect();
      frame.removeEventListener('load', loaded);
      frame.removeEventListener('error', failed);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const failed = () => fail(new Error('Reader frame could not load'));
    const loaded = () => {
      cleanup();
      if (!frame.isConnected || !frame.contentDocument) {
        reject(new DOMException('Reader frame was detached', 'AbortError'));
        return;
      }
      try { resolve(onLoad()); } catch (error) { reject(error); }
    };
    // Mutation observers do not cross shadow boundaries. Observe every owner
    // root, including the document containing the React reader container.
    let root = frame.getRootNode();
    while (root instanceof ShadowRoot) {
      observer.observe(root, { childList: true, subtree: true });
      root = root.host.getRootNode();
    }
    observer.observe(frame.ownerDocument, { childList: true, subtree: true });
    frame.addEventListener('load', loaded);
    frame.addEventListener('error', failed);
    try { frame.src = src; } catch (error) { fail(error); }
  });
}
