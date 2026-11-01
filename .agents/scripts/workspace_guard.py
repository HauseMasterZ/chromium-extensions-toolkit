#!/usr/bin/env python3
"""
Workspace Boundary Guard for CToolkit.
Mechanically intercepts and blocks any tool calls or shell commands targeting
directories, repositories, or files outside the authorized CToolkit workspace.
"""
import sys
import json
import os
import re

def normalize_path(p):
    if not p or not isinstance(p, str):
        return ""
    try:
        return os.path.realpath(os.path.abspath(p)).lower()
    except Exception:
        return p.strip().replace('/', '\\').lower()

def is_path_safe(target_path, allowed_roots):
    norm_target = normalize_path(target_path)
    if not norm_target:
        return False
    for root in allowed_roots:
        norm_root = normalize_path(root)
        if not norm_root:
            continue
        if norm_target == norm_root or norm_target.startswith(norm_root + os.sep):
            return True
    return False

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"decision": "allow"}))
            return

        data = json.loads(raw_input)
        tool_call = data.get("toolCall", {})
        tool_name = tool_call.get("name", "")
        args = tool_call.get("args", {})

        # Compute authorized workspace root
        script_dir = os.path.dirname(os.path.abspath(__file__))
        ctoolkit_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
        allowed_roots = [ctoolkit_root]

        for p in data.get("workspacePaths", []):
            if p:
                allowed_roots.append(p)

        artifact_dir = data.get("artifactDirectoryPath")
        if artifact_dir:
            allowed_roots.append(artifact_dir)

        # Allow conversation brain / transcript directory for diagnostics
        brain_root = os.path.expanduser("~/.gemini/antigravity-cli")
        if os.path.exists(brain_root):
            allowed_roots.append(brain_root)

        # 1. Inspect direct file access tools
        if tool_name in ("read_file", "write_file", "edit_file"):
            target_path = args.get("Path", "")
            if target_path and not is_path_safe(target_path, allowed_roots):
                print(json.dumps({
                    "decision": "deny",
                    "reason": f"MECHANICAL HARD-GATE: Access denied. Path '{target_path}' is outside the authorized CToolkit workspace."
                }))
                return

        # 2. Inspect shell commands
        if tool_name == "run_command":
            cmd = args.get("CommandLine", "")

            # Block commands targeting external projects in Code directory
            blocked_sibling_pattern = r"(?i)[\"']?[A-Z]:[\\/]+Users[\\/]+[^\n\r\\/]+[\\/]+Documents[\\/]+Code[\\/]+(?!CToolkit\b)[a-zA-Z0-9_.-]+"
            if re.search(blocked_sibling_pattern, cmd):
                print(json.dumps({
                    "decision": "deny",
                    "reason": "MECHANICAL HARD-GATE: Command references an unauthorized external project directory."
                }))
                return

            # Block explicit names of known external projects
            known_external = r"(?i)\b(PiYT|alwaysdata-pi-setup|eduresumer|floresumer|Heroic|NvidiaUndervolt|alienfx-tools)\b"
            if re.search(known_external, cmd):
                print(json.dumps({
                    "decision": "deny",
                    "reason": "MECHANICAL HARD-GATE: Command references external project repository name."
                }))
                return

            # Block multi-level parent directory traversal out of workspace
            if re.search(r"(?i)(\.\.[\\/]){2,}", cmd):
                print(json.dumps({
                    "decision": "deny",
                    "reason": "MECHANICAL HARD-GATE: Multi-level directory traversal out of workspace is blocked."
                }))
                return

        print(json.dumps({"decision": "allow"}))
    except Exception as e:
        # On failure to parse or error, default to deny for safety
        print(json.dumps({
            "decision": "deny",
            "reason": f"MECHANICAL HARD-GATE: Hook encountered error during inspection: {str(e)}"
        }))

if __name__ == "__main__":
    main()
