/**
 * Renders a login payload as a scannable QR image, server-side.
 *
 * SERVER-SIDE on purpose, and not a React QR component: the payload is a live credential for as
 * long as the challenge lives, so it is turned into a picture on the server and only the picture
 * (a `data:` URL) travels to the browser. A client-side renderer would ship the payload into the
 * DOM where a reader, an extension or a screenshot could lift it.
 *
 * The colours are FIXED black-on-white and ignore the app theme, because an inverted or
 * low-contrast QR is a code the phone cannot read — and a QR the phone cannot read looks exactly
 * like a broken feature. Error correction `M` tolerates the logo-sized centre mark some readers
 * draw over it without inflating the module count for a long URL.
 */

import 'server-only';

import QRCode from 'qrcode';

export async function renderQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
