"""Passive capture of the DLH gateway: authenticate, then record every line. Sends no commands.

Usage:
  set -a; . ./.env; set +a
  python3 research/capture.py OUT.jsonl SECONDS

Reads GATEWAY_HOST, GATEWAY_PORT and GATEWAY_EMAIL from the environment. The auth line is
never recorded, and the email is replaced with <email> in everything written. Reconnects
with backoff if the link drops. On a python.org macOS install with no CA bundle, also set
SSL_CERT_FILE=/etc/ssl/cert.pem.
"""
import json, os, socket, ssl, sys, time

host, port, email = os.environ['GATEWAY_HOST'], int(os.environ['GATEWAY_PORT']), os.environ['GATEWAY_EMAIL']
out = open(sys.argv[1], 'w'); duration = float(sys.argv[2])

def log(kind, **kw):
    kw.update(kind=kind, rx_ms=int(time.time() * 1000))
    out.write(json.dumps(kw).replace(email, '<email>') + '\n'); out.flush()

end = time.time() + duration; attempt = 0
ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE'))
while time.time() < end:
    attempt += 1
    try:
        raw = socket.create_connection((host, port), timeout=10)
        s = ctx.wrap_socket(raw, server_hostname=host); s.settimeout(5)
        log('connected', attempt=attempt)
        s.sendall((json.dumps({'type': 'auth', 'email': email}) + '\n').encode())
        buf = b''
        while time.time() < end:
            try: chunk = s.recv(65536)
            except socket.timeout: log('rx_timeout'); continue
            if not chunk: log('closed_by_peer'); break
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                try: log('msg', m=json.loads(line))
                except Exception: log('unparseable', raw=line.decode('utf-8', 'replace')[:500])
        s.close()
    except Exception as e:
        log('error', err=repr(e))
    if time.time() < end: time.sleep(min(2 ** min(attempt, 4), 10))
log('done')
