const objloader = require("obj-loader");
const options = require("@jhanssen/options")("objserver");
const glob = require("glob");
const path = require("path");
const fs = require("fs");
const http = require("http");
const mime = require("mime-types");
const toBuffer = require("typedarray-to-buffer");
const datefns = require("date-fns");

const dir = options("dir", ".");
const port = options.int("port", 8082);

const realDir = fs.realpathSync(dir);

const data = new Map();
let server;

const date = {
    log: function(...args) {
        console.log.call(console, datefns.format(new Date(), "HH:mm:ss"), ...args);
    },
    error: function(...args) {
        console.error.call(console, datefns.format(new Date(), "HH:mm:ss"), ...args);
    }
};

function makeFloat32Array(arr)
{
    if (!arr || arr.length === 0)
        return undefined;
    const f32 = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; ++i) {
        f32[i] = arr[i];
    }
    return toBuffer(f32);
}

function makeVertexIndexBuffer(attrib, shapes)
{
    const m = new Map();
    let vc = 0;
    let ic = 0;

    let curshape = 0;

    const vbounds = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];

    const v32 = new Float32Array(attrib.faces.length * 5); // * 5 is worst case scenario, (x, y, z, t0, t1)
    let i32 = new Uint32Array(attrib.faces.length);

    const i32s = [];

    for (let fc = 0; fc < attrib.faces.length; ++fc) {
        const face = attrib.faces[fc];

        while (fc >= shapes[curshape]._offset + shapes[curshape]._length) {
            const bi32 = toBuffer(i32);
            i32s.push(bi32.slice(0, ic * Uint32Array.BYTES_PER_ELEMENT));

            i32 = new Uint32Array(attrib.faces.length * 2);
            ic = 0;

            ++curshape;
        }

        const v = [
            attrib.vertices[3 * face[0] + 0],
            attrib.vertices[3 * face[0] + 1],
            attrib.vertices[3 * face[0] + 2]
        ];
        const t = [
            attrib.texcoords[2 * face[2] + 0],
            1.0 - attrib.texcoords[2 * face[2] + 1]
        ];
        const k = `${face[0]}:${face[2]}`;
        const f = m.get(k);
        if (f === undefined) {
            // insert
            m.set(k, vc / 5);

            v32[vc + 0] = v[0];
            v32[vc + 1] = v[1];
            v32[vc + 2] = v[2];
            v32[vc + 3] = t[0];
            v32[vc + 4] = t[1];

            if (v[0] < vbounds[0])
                vbounds[0] = v[0];
            if (v[0] > vbounds[3])
                vbounds[3] = v[0];
            if (v[1] < vbounds[1])
                vbounds[1] = v[1];
            if (v[1] > vbounds[4])
                vbounds[4] = v[1];
            if (v[2] < vbounds[2])
                vbounds[2] = v[2];
            if (v[2] > vbounds[5])
                vbounds[5] = v[2];

            i32[ic] = vc / 5;

            vc += 5;
            ic += 1;
        } else {
            i32[ic] = f;
            ic += 1;
        }
    }

    if (ic > 0) {
        const bi32 = toBuffer(i32);
        i32s.push(bi32.slice(0, ic * Uint32Array.BYTES_PER_ELEMENT));
    }

    let mc = 0;
    const mchange = new Uint32Array(attrib.materialId.length * 2);
    for (let i = 0; i < attrib.materialId.length; ++i) {
        if (i === 0 || mchange[mc - 1] !== attrib.materialId[i]) {
            mchange[mc + 0] = i;
            mchange[mc + 1] = attrib.materialId[i];
            mc += 2;
        }
    }

    const bv32 = toBuffer(v32);
    const bmchange = toBuffer(mchange);

    return {
        i32s: i32s,
        v32: bv32.slice(0, vc * Float32Array.BYTES_PER_ELEMENT),
        mchange: bmchange.slice(0, mc * Uint32Array.BYTES_PER_ELEMENT),
        bounds: vbounds
    };
}

function prepare(dir, file)
{
    //const name = path.basename(dir);
    //console.log("prep", file);
    const ext = path.extname(file);
    const base = file.substr(0, file.length - ext.length);

    const loader = fn => {
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(dir, fn), "utf8", (err, data) => {
                if (err || !data) {
                    reject(err || "No data");
                } else {
                    resolve(data);
                }
            });
        });
    };

    loader(file).then(data => {
        return objloader(data, loader, true /* triangulate */);
    }).then(obj => {
        //const v32 = makeFloat32Array(obj.attrib.vertices);
        const vi = makeVertexIndexBuffer(obj.attrib, obj.shapes);

        data.set(base, {
            vi: vi,
            obj: obj,
        });
    }).catch(e => {
        console.error(e);
        process.exit(1);
    });
}

function serve()
{
    date.log(`listening on ${port}`);
    const listener = (req, res) => {
        const writeJson = jsonstr => {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": jsonstr.length
            });
            res.end(jsonstr);
        };
        const writeBlob = blobdata => {
            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": blobdata.length
            });
            res.end(blobdata);
        };
        const serveFile = f => {
            date.log("serving", f);
            fs.readFile(f, (err, data) => {
                if (err || !data) {
                    res.writeHead(500);
                    res.end();
                } else {
                    res.writeHead(200, {
                        "Content-Type": mime.lookup(path.extname(f)),
                        "Content-Length": data.length
                    });
                    res.end(data);
                }
            });
        };
        const maybeServeFile = (f, base) => {
            fs.realpath(f, (err, rp) => {
                if (err || !rp || rp.length === 0) {
                    res.writeHead(500);
                    res.end();
                } else {
                    // verify that rp contains base
                    if (rp.indexOf(base) !== 0) {
                        res.writeHead(404);
                        res.end();
                    } else {
                        // serve the file
                        serveFile(rp);
                    }
                }
            });
        };
        const maybeServeResource = p => {
            const fp = p.join("/");
            maybeServeFile(fp, realDir);
        };

        const p = req.url.split("/").filter(a => a.length > 0);
        if (p.length === 0 || p[0].length === 0) {
            serveFile(path.join(__dirname, "gibbon.js"));
        } else if (p[0] === "all") {
            writeJson(JSON.stringify(Array.from(data.keys())));
        } else if (p[0] === "gl-matrix-min.js") {
            // special case for gl-matrix
            serveFile(path.join(__dirname, "../node_modules/gl-matrix/gl-matrix-min.js"));
        } else {
            const ext = path.extname(p[0]);
            if (ext === ".js") {
                maybeServeFile(path.join(__dirname, p[0]), __dirname);
                return;
            }

            const d = data.get(p[0]);
            if (!d) {
                res.writeHead(404);
                res.end();
            } else {
                if (p.length === 1 || p[1].length === 0) {
                    // overview
                    const shapes = [];
                    for (const shape of d.obj.shapes) {
                        shapes.push({ name: shape.name, offset: shape.faceOffset, length: shape.length });
                    }
                    const mats = [];
                    for (const mat of d.obj.attrib.materials) {
                        mats.push({
                            id: mat.id, ka: mat.ka, kd: mat.kd, ks: mat.ks, kt: mat.kt, ni: mat.ni,
                            ke: mat.ke, ns: mat.ns, illum: mat.illum, d: mat.d, map_Ka: mat.map_Ka,
                            map_Kd: mat.map_Kd, map_Ks: mat.map_Ks, map_Ns: mat.map_Ns,
                            map_bump: mat.map_bump, map_d: mat.map_d, disp: mat.disp
                        });
                    }
                    const out = {
                        materials: mats,
                        shapes: shapes,
                        bounds: d.vi.bounds
                    };
                    writeJson(JSON.stringify(out));
                } else {
                    switch (p[1]) {
                    case "vertices":
                        writeBlob(d.vi.v32);
                        break;
                    case "indices":
                        if (p.length === 2) {
                            writeJson(JSON.stringify({ num: d.vi.i32s.length }));
                        } else {
                            const num = parseInt(p[2]);
                            if (num < d.vi.i32s.length) {
                                writeBlob(d.vi.i32s[num]);
                            } else {
                                res.writeHead(404);
                                res.end();
                            }
                        }
                        break;
                    case "mchange":
                        writeBlob(d.vi.mchange);
                        break;
                    case "resource":
                        maybeServeResource(p.slice(2));
                        break;
                    default:
                        res.writeHead(404);
                        res.end();
                    }
                }
            }
        }
    };
    server = http.createServer(listener);
    server.listen(port);
}

glob(path.join(dir, "*.obj"), (err, files) => {
    if (err || !files) {
        console.error(err);
        process.exit(1);
    }
    if (files.length === 0) {
        console.error(`no *.obj files in ${dir}`);
        process.exit(1);
    }

    for (const file of files) {
        prepare(dir, file);
    }

    serve();
});
