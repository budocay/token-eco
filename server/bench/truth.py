"""Python ground truth via the ast module: reads paths on stdin, writes JSON.
For each file: declarations {name, start, end, decl_line} (1-indexed; start includes decorators)."""
import ast, json, sys

res = {}
for path in sys.stdin.read().split():
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except Exception:
        continue
    decls = []
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = min([d.lineno for d in n.decorator_list] + [n.lineno])
            decls.append({"name": n.name, "start": start, "decl_line": n.lineno, "end": n.end_lineno})
    for n in tree.body:  # module-level UPPERCASE constants
        if isinstance(n, (ast.Assign, ast.AnnAssign)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            for t in targets:
                if isinstance(t, ast.Name) and t.id.isupper():
                    decls.append({"name": t.id, "start": n.lineno, "decl_line": n.lineno, "end": n.end_lineno})
    res[path] = decls
json.dump(res, sys.stdout)
