const { createAppServer } = require("../server.js");

// Inisialisasi server
const serverPromise = createAppServer({ dataDir: "/tmp" });

module.exports = async (req, res) => {
  const server = await serverPromise;
  server.emit("request", req, res);
};