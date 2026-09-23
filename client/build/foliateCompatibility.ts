// Renderer fixes for foliate-js 78914aef4466eb960965702401634c2cb348e9b1.
// Detached iframes lose contentDocument before queued style/font/resize callbacks
// run. Guard those callbacks in both dev and production, without modifying the
// installed package. Exact matches deliberately fail when upstream changes.
function replaceExactly(source: string, fixes: ReadonlyArray<readonly [string, string]>): string {
  let code = source.replaceAll('\r\n', '\n');
  for (const [before, after] of fixes) {
    if (code.split(before).length !== 2) {
      throw new Error('Pinned foliate renderer source changed; review disposal compatibility fixes before upgrading.');
    }
    code = code.replace(before, after);
  }
  return code;
}

export function guardFoliateDisposal(source: string): string {
  return replaceExactly(source, [
    [
      '    render(layout) {\n        if (!layout) return',
      '    render(layout) {\n        if (!layout || !this.document) return',
    ],
    [
      '    expand() {\n        const { documentElement } = this.document',
      '    expand() {\n        const doc = this.document\n        if (!doc) return\n        const { documentElement } = doc',
    ],
    [
      '    render() {\n        if (!this.#view) return',
      '    render() {\n        if (!this.#view?.document) return',
    ],
    [
      '        requestAnimationFrame(() =>\n            this.#background.style.background = getBackground(this.#view.document))',
      '        requestAnimationFrame(() => {\n            const doc = this.#view?.document\n            if (doc) this.#background.style.background = getBackground(doc)\n        })',
    ],
    [
      'this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())',
      'this.#view?.document?.fonts?.ready?.then(() => this.#view?.expand())',
    ],
    [
      '        if (this.document) this.#observer.unobserve(this.document.body)',
      '        this.#observer.disconnect()',
    ],
    [
      '        this.#observer.unobserve(this)\n        this.#view.destroy()',
      '        this.#observer.disconnect()\n        this.#view?.destroy()',
    ],
    [
      "        return new Promise(resolve => {\n            this.#iframe.addEventListener('load', () => {",
      '        return loadFoliateFrame(this.#iframe, src, () => {',
    ],
    [
      '                resolve()\n            }, { once: true })\n            this.#iframe.src = src\n        })',
      '        })',
    ],
  ]);
}

export function guardFoliateFixedLayoutDisposal(source: string): string {
  return replaceExactly(source, [
    [
      '                const spread = last.left || last.right ? newSpread() : last',
      '                const spread = last.left || last.right || last.center ? newSpread() : last',
    ],
    // Reusing a spread must update its active side before reporting the exact
    // section. Rendering alone changes pixels while leaving location stale.
    [
      '        if (index === this.#index) {\n            this.#render(side)\n            return\n        }',
      '        if (index === this.#index) {\n            this.#side = side ?? this.#side\n            this.#render()\n            this.#reportLocation(reason)\n            return\n        }',
    ],
    [
      "        return new Promise(resolve => {\n            iframe.addEventListener('load', () => {",
      '        return loadFoliateFrame(iframe, src, () => {',
    ],
    [
      '                resolve({\n                    element, iframe,',
      '                return {\n                    element, iframe,',
    ],
    [
      '                    onZoom,\n                })\n            }, { once: true })\n            iframe.src = src\n        })',
      '                    onZoom,\n                }\n        })',
    ],
  ]);
}
