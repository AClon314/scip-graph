/** raw-mode 输入解析：与 UI 库无关，纯字符串 → 键事件。 */

export type Key =
  | { type: 'char'; ch: string }
  | {
      type:
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'enter'
        | 'tab'
        | 'shift-tab'
        | 'backspace'
        | 'esc'
        | 'ctrl-c';
    };

const SEQS: Record<string, Key> = {
  '\x1b[A': { type: 'up' },
  '\x1b[B': { type: 'down' },
  '\x1b[C': { type: 'right' },
  '\x1b[D': { type: 'left' },
  '\x1b[Z': { type: 'shift-tab' },
  '\r': { type: 'enter' },
  '\n': { type: 'enter' },
  '\t': { type: 'tab' },
  '\x7f': { type: 'backspace' },
  '\b': { type: 'backspace' },
  '\x1b': { type: 'esc' },
  '\x03': { type: 'ctrl-c' },
};

/** 解析一个可能含多键的输入块。 */
export function parseKeys(buf: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < buf.length) {
    let matched = false;
    for (const [seq, key] of Object.entries(SEQS)) {
      if (buf.startsWith(seq, i)) {
        keys.push(key);
        i += seq.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const code = buf.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    if (code >= 0x20 && code !== 0x7f) keys.push({ type: 'char', ch });
    i += ch.length;
  }
  return keys;
}

/** 给无 TTY 的测试/脚本用：`"tab down down enter text:hello q"` → Key[]。 */
export function decodeKeySpec(spec: string): Key[] {
  const keys: Key[] = [];
  for (const tok of spec.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('text:')) for (const ch of tok.slice(5)) keys.push({ type: 'char', ch });
    else if (tok === 'bs') keys.push({ type: 'backspace' });
    else if (tok === 's-tab') keys.push({ type: 'shift-tab' });
    else if (tok === 'ctrl-c') keys.push({ type: 'ctrl-c' });
    else if (tok.length === 1) keys.push({ type: 'char', ch: tok });
    else keys.push({ type: tok as Key['type'] } as Key);
  }
  return keys;
}
