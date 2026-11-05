# iOS WebKit: fetch() stream chunks held back until the next chunk arrives

Minimal test case for a WebKit bug report. No framework and no dependencies:
one small Node.js server and one HTML page.

**Symptom.** While the main thread is busy processing earlier chunks of a
streaming `fetch()` response, chunks that have already arrived are not delivered
to `reader.read()`. They stay held back until the next network data arrives, even
though the reader is waiting. `XMLHttpRequest` with the same server, burst and busy
work did not show this.

## How it works

The server sends a burst of 10 frames (256 bytes, about 4 ms apart), stays silent
for 2.5 seconds, then sends one marker frame and ends the response.

The page reads the response and blocks the main thread per frame received, standing
in for an app that processes each message. A frame that has not reached the reader
within 1.5 seconds of the first chunk counts as held back. That window is longer
than the busy work can delay reading (10 x 90 ms) and shorter than the silence.

| Scenario | Transport | Work per frame |
|---|---|---|
| A | `fetch()` + `body.getReader()` | 90 ms |
| B | `fetch()` + `body.getReader()` | none |
| C | `XMLHttpRequest` `progress` events | 90 ms |

## Run

Tested with Node.js 22. The phone must be able to reach the machine.

```sh
node server.mjs --http      # plain HTTP/1.1 on port 8080 - no certificate needed
```

Open `http://<machine-ip>:8080/` on the iPhone, press **Start** and keep the page
in the foreground for about a minute. The page shows the result, and the server
prints each run and appends it to `results.log`.

To test HTTPS + HTTP/2 on port 8443, create a certificate first. iOS rejects a
self-signed certificate without `serverAuth`, so keep those options:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
  -keyout key.pem -out cert.pem -subj "/CN=stream-stall-test" \
  -addext "subjectAltName=IP:<machine-ip>" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "basicConstraints=critical,CA:FALSE"
node server.mjs
```

## Results

Runs with held-back frames, out of 5 per scenario:

| Environment | A: fetch + work | B: fetch, no work | C: XHR + work |
|---|---|---|---|
| iPhone, iOS 27.0.1, Safari, HTTP/1.1 | **5/5** | 0/5 | 0/5 |
| iPhone, iOS 27.0.1, Safari, HTTPS + HTTP/2 | **4/5** | 0/5 | 0/5 |
| Windows, Chrome 156, HTTP/1.1 | 0/5 | 0/5 | 0/5 |

iPhone and server were on the same Wi-Fi network. macOS Safari has not been tested.

Example from scenario A on HTTP/1.1 (`milliseconds:bytes` as seen by the reader):

```
359:1024, 719:256, 3020:1280, 3470:256
```

Five frames arrived by 719 ms. The other 1280 bytes were delivered only at 3020 ms,
when the silence ended. In scenario C the same frames all arrive before the silence:

```
408:1792, 1089:768, 3068:256
```
