const {parse} = require("url");
const {info, error} = require("./utils");
const {Server} = require("node-static");
const formidable = require("formidable");

const bodyParser = request =>
  new Promise((resolve, reject) => {
    let form = new formidable.IncomingForm();
    form.parse(request, (err, fields, files) =>
      err ? reject(err) : resolve({fields, files}))
  });

class ServerRequest {
  constructor(request, response) {
    this.request = request;
    this.response = response;

    this.method = request.method.toLowerCase();
    this.url = parse(request.url, true);
    this.path = this.url.pathname;
    this.ip = request.headers["x-forwarded-for"] ||
              request.connection.remoteAddress;

    this.params = {query: this.url.query, header: this.request.headers};
  }
  
  async parse() {
    let {fields, files} = await bodyParser(this.request);
    this.params.body = Object.assign({}, fields, files);
    return this;
  }
  
  send(contentType, content) {
    this.response.setHeader("Content-Type", contentType);
    this.response.end(content);
  }

  stream() {
    this.response.setHeader("Content-Type", "text/event-stream");
    this.response.setHeader("Connection", "keep-alive");
    this.response.write("event: update\n");

    let interval = setInterval(() => this.response.write(" "), 30000);
    this.response.connection.on("close", () => clearInterval(interval));

    return data => this.response.write(`\ndata: ${JSON.stringify(data)}\n\n`);
  }

  error(err, message) {
    this.response.writeHead(err, {"Content-Type": "text/plain"});
    this.response.end(message);
  }

  onclose(fn) {
    this.request.connection.on("close", fn);
  }

  handleError(err) {
    if (typeof err === "string") return this.error(400, err);
    if (err.expose) return this.error(err.error, err.message);
    return this.error(500, "Server Error");
  }

  static attach(handler, responders) {
    let fileServer = ((handler || {}).settings || {}).static ?
                     new Server(handler.settings.static.path) : null;
                     
    return (req, res, next) => {
      let request = new this(req, res);
      let match = handler.match(request.method, request.path);

      if (!match && handler.settings && handler.settings.static)
        return fileServer.serve(req, res, (err, result) => {
          if (err && err.status === 404)
            return next ? next() : request.error(404, "Not Found")
        });

      if (!match) return next ? next() : request.error(404, "Not Found")
      info(`REQUEST: ${request.method} ${request.path} from ${request.ip}`);

      request.parse()
      .then(req => handler.handle(req, match))
      .then(out => responders.find(match, request, out).responder(match, request, out))
      .catch(err => {error(`ERROR: ${err}`); request.handleError(err)});
    };
  }
}

module.exports = ServerRequest;
