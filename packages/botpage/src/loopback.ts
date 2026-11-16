/**
 * Whether `address` is a loopback address or the `localhost` name.
 * Covers 127.0.0.0/8, ::1 and IPv4-mapped IPv6 loopback (::ffff:127.x.y.z).
 * Wildcards such as `0.0.0.0` and `::` are not loopback: they accept
 * connections from every interface.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let host = address.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
