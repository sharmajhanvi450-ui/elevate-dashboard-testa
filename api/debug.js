export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({ ok: true, note: "Scratch debug endpoint — currently idle." });
}
