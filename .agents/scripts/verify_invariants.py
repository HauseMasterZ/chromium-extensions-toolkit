#!/usr/bin/env python3
"""
Mechanical Invariant Verification Engine for CToolkit.
Enforces hard architectural and behavioral invariants:
1. WebHID Dormancy & Info Panel Boundary Invariant
2. Modified Code LF Line Ending Invariant
3. Strictly Zero Emojis Invariant
"""
import os
import re
import subprocess
import sys

def check_webhid_invariants(repo_root):
    newtab_js = os.path.join(repo_root, "Toolkit", "newtab-script.js")
    if not os.path.exists(newtab_js):
        return ["Toolkit/newtab-script.js not found."]

    with open(newtab_js, "r", encoding="utf-8") as f:
        content = f.read()

    errors = []

    # 1. Verify initAtkWebHid has strict infoState === 3 guard
    init_match = re.search(r"async\s+function\s+initAtkWebHid\s*\([^)]*\)\s*\{([\s\S]*?)\n\}", content)
    if not init_match:
        errors.append("initAtkWebHid() definition not found in Toolkit/newtab-script.js.")
    else:
        body = init_match.group(1)
        if "infoState !== 3" not in body and "infoState === 3" not in body:
            errors.append("INVARIANT VIOLATION: initAtkWebHid() lacks strict infoState === 3 guard. Must never query or access WebHID outside State 3.")

    # 2. Verify checkAndQueryAtkMouseOnDemand has strict infoState === 3 guard
    check_match = re.search(r"async\s+function\s+checkAndQueryAtkMouseOnDemand\s*\([^)]*\)\s*\{([\s\S]*?)\n\}", content)
    if not check_match:
        errors.append("checkAndQueryAtkMouseOnDemand() definition not found in Toolkit/newtab-script.js.")
    else:
        body = check_match.group(1)
        if "infoState !== 3" not in body and "infoState === 3" not in body:
            errors.append("INVARIANT VIOLATION: checkAndQueryAtkMouseOnDemand() lacks strict infoState === 3 guard.")

    # 3. Verify queryAtkMouseState has infoState === 3 guard before lock/device.open
    query_match = re.search(r"async\s+function\s+queryAtkMouseState\s*\([^)]*\)\s*\{([\s\S]*?)isMouseQuerying\s*=\s*true", content)
    if not query_match:
        errors.append("queryAtkMouseState() definition or lock acquisition not found in Toolkit/newtab-script.js.")
    else:
        pre_lock = query_match.group(1)
        if "infoState !== 3" not in pre_lock and "infoState === 3" not in pre_lock:
            errors.append("INVARIANT VIOLATION: queryAtkMouseState() lacks infoState === 3 guard before acquiring lock or opening device.")

    # 4. Verify no unconditional device.open() outside function blocks (zero indentation)
    top_open = re.findall(r"^device\.open\s*\(", content, re.MULTILINE)
    if top_open:
        errors.append(f"INVARIANT VIOLATION: Top-level device.open() invocation detected: {top_open}")

    return errors

def get_modified_files(repo_root):
    files = set()
    try:
        res = subprocess.run(["git", "diff", "--name-only", "HEAD"], cwd=repo_root, capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip():
            for line in res.stdout.strip().splitlines():
                if line.strip():
                    files.add(line.strip().replace("/", os.sep))
    except Exception:
        pass

    try:
        res = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=repo_root, capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip():
            for line in res.stdout.strip().splitlines():
                if line.strip():
                    files.add(line.strip().replace("/", os.sep))
    except Exception:
        pass

    # Always include newtab-script.js in the audit
    files.add(os.path.join("Toolkit", "newtab-script.js"))
    return [os.path.join(repo_root, f) for f in files if os.path.exists(os.path.join(repo_root, f))]

def check_file_hygiene(files, repo_root):
    errors = []
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"  # emoticons
        "\U0001F300-\U0001F5FF"  # symbols & pictographs
        "\U0001F680-\U0001F6FF"  # transport & map symbols
        "\U0001F900-\U0001F9FF"  # Supplemental Symbols and Pictographs
        "\U0001FA70-\U0001FAFF"  # Symbols and Pictographs Extended-A
        "]"
    )

    extensions = (".js", ".html", ".css", ".json", ".ps1", ".bat", ".py", ".md")

    for fp in files:
        if not fp.endswith(extensions):
            continue
        rel = os.path.relpath(fp, repo_root)

        # Check line endings
        try:
            with open(fp, "rb") as f:
                data = f.read()
            if b"\r\n" in data:
                errors.append(f"INVARIANT VIOLATION: CRLF line endings detected in '{rel}'. Must be pure LF.")
        except Exception:
            pass

        # Check emojis
        try:
            with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
            if emoji_pattern.search(text):
                errors.append(f"INVARIANT VIOLATION: Emoji detected in '{rel}'. Strictly zero emojis allowed.")
        except Exception:
            pass

    return errors

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(script_dir, "..", ".."))

    all_errors = []
    all_errors.extend(check_webhid_invariants(repo_root))

    modified = get_modified_files(repo_root)
    all_errors.extend(check_file_hygiene(modified, repo_root))

    if all_errors:
        print("MECHANICAL INVARIANT CHECK FAILED:")
        for err in all_errors:
            print(f"  - {err}")
        sys.exit(1)

    print("ALL MECHANICAL INVARIANTS SATISFIED.")
    sys.exit(0)

if __name__ == "__main__":
    main()
