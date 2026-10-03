"""Export a Claude Code session transcript into ai-sessions/, scrubbed of personal data.

Usage:
  python3 tools/export_session.py SESSION.jsonl OUT_BASENAME "Title"

Writes OUT_BASENAME.jsonl (the full transcript, scrubbed) and OUT_BASENAME.md (a readable rendering:
prompts, the agent's text, each tool call with its input, and each tool result, long ones cut).

Scrubbing: every key whose name contains "email" is dropped, and every email address anywhere is
replaced with <redacted-email>, except the placeholders in ALLOWED. The script then re-reads what it
wrote and refuses to finish if any non-allowed address survives.
"""
import json, re, sys

ALLOWED = {'noreply@anthropic.com', 'you@example.com'}
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
CUT = 2500


def scrub(x):
    if isinstance(x, dict):
        return {k: scrub(v) for k, v in x.items() if 'email' not in k.lower()}
    if isinstance(x, list):
        return [scrub(v) for v in x]
    if isinstance(x, str):
        return EMAIL.sub(lambda m: m.group(0) if m.group(0).lower() in ALLOWED else '<redacted-email>', x)
    return x


def cut(s):
    s = s if isinstance(s, str) else json.dumps(s, indent=1)
    return s if len(s) <= CUT else s[:CUT] + '\n… [%d more characters in the .jsonl]' % (len(s) - CUT)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(c.get('text', '') if isinstance(c, dict) else str(c) for c in content)
    return str(content)


def render(records, title):
    out = ['# ' + title, '', 'Exported from the Claude Code transcript; personal data scrubbed. '
           'Tool results longer than %d characters are cut here and complete in the .jsonl.' % CUT, '']
    for r in records:
        msg = r.get('message')
        if r.get('type') not in ('user', 'assistant') or not isinstance(msg, dict):
            continue
        stamp = r.get('timestamp', '')
        content = msg.get('content')
        if isinstance(content, str):
            out += ['## Prompt (%s)' % stamp, '', content, '']
            continue
        for c in content or []:
            kind = c.get('type')
            if kind == 'text' and c.get('text', '').strip():
                who = 'Agent' if r['type'] == 'assistant' else 'Prompt'
                out += ['### %s (%s)' % (who, stamp), '', c['text'], '']
            elif kind == 'thinking' and c.get('thinking', '').strip():
                out += ['<details><summary>Thinking</summary>', '', c['thinking'], '', '</details>', '']
            elif kind == 'tool_use':
                out += ['**Tool: %s**' % c.get('name'), '', '```json', cut(c.get('input')), '```', '']
            elif kind == 'tool_result':
                out += ['<details><summary>Result</summary>', '', '```', cut(text_of(c.get('content'))), '```', '', '</details>', '']
    return '\n'.join(out) + '\n'


def main():
    src, base, title = sys.argv[1], sys.argv[2], sys.argv[3]
    records = [scrub(json.loads(l)) for l in open(src) if l.strip()]
    with open(base + '.jsonl', 'w') as f:
        for r in records:
            f.write(json.dumps(r) + '\n')
    with open(base + '.md', 'w') as f:
        f.write(render(records, title))
    for path in (base + '.jsonl', base + '.md'):
        left = {m for m in EMAIL.findall(open(path).read()) if m.lower() not in ALLOWED}
        if left:
            sys.exit('refusing: %s still contains %d email address(es)' % (path, len(left)))
    print('%s: %d records' % (base, len(records)))


if __name__ == '__main__':
    main()
