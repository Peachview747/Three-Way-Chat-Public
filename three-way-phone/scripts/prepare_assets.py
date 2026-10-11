from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
types = {'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8'}
assets = {('/' if name == 'index.html' else '/' + name): [mime, (root / 'web' / name).read_text(encoding='utf-8')] for name, mime in types.items()}
(root / 'cloudflare' / 'assets.mjs').write_text('export const assets = ' + json.dumps(assets, ensure_ascii=False) + ';\n', encoding='utf-8')
