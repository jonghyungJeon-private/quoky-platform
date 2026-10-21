# Resolves append-at-top conflicts in CHANGELOG.md / CURRENT_STATE.md by keeping both sides (incoming first).
import sys,re
p=sys.argv[1]; s=open(p).read()
while True:
    m=re.search(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", s, re.S)
    if not m: break
    s=s[:m.start()]+m.group(2).rstrip("\n")+"\n\n"+m.group(1)+s[m.end():]
open(p,'w').write(s)
