import sys

path = '/home/divyansh/circuitbreaker-ai/tests/integration/proxy.test.ts'
with open(path, 'r') as f:
    c = f.read()

old = 'mockServer.listen({ onUnhandledRequest: " warn\
