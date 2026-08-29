import re
import sys

def sanitize(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove proxy script DOM injection
    clean = re.sub(r'\("darkreader--proxy"\);.*?document\.head\.insertBefore.*?e\.remove\(\)\}', '("darkreader--proxy");/* CSP safe */}', content)

    # 2. Replace createElement("script") with style
    clean = re.sub(r'document\.createElement\(["\']script["\']\)', 'document.createElement("style")', clean)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(clean)

    print(f'DarkReader successfully sanitized: {filepath}')

if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'Toolkit/darkreader.js'
    sanitize(target)
