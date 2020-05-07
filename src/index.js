const objloader = require("obj-loader");
const options = require("@jhanssen/options")("objserver");
const glob = require("glob");
const path = require("path");
const fs = require("fs");
const http = require("http");
const mime = require("mime-types");
const toBuffer = require("typedarray-to-buffer");

const dir = options("dir", ".");
const port = options.int("port", 8082);

const realDir = fs.realpathSync(dir);

const data = new Map();
let server;

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

function makeVertexIndexBuffer(attrib)
{
    const m = new Map();
    let vc = 0;
    let ic = 0;

    const v32 = new Float32Array(attrib.faces.length * 5); // * 5 is worst case scenario, (x, y, z, t0, t1)
    const i32 = new Uint32Array(attrib.faces.length);
    for (const face of attrib.faces) {
        const v = [
            attrib.vertices[3 * face[0] + 0],
            attrib.vertices[3 * face[0] + 1],
            attrib.vertices[3 * face[0] + 2]
        ];
        const t = [
            attrib.texcoords[2 * face[2] + 0],
            1.0 - attrib.texcoords[2 * face[2] + 1]
        ];
        const k = `${v[0]}:${v[1]}:${v[2]}:${t[0]}:${t[1]}`;
        const f = m.get(k);
        if (f === undefined) {
            // insert
            m.set(k, vc);

            v32[vc + 0] = v[0];
            v32[vc + 1] = v[1];
            v32[vc + 2] = v[2];
            v32[vc + 3] = t[0];
            v32[vc + 4] = t[1];

            i32[ic] = vc;

            vc += 5;
            ic += 1;
        } else {
            i32[ic] = f;
            ic += 1;
        }
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
    const bi32 = toBuffer(i32);
    const bmchange = toBuffer(mchange);

    return {
        v32: bv32.slice(0, vc * Float32Array.BYTES_PER_ELEMENT),
        i32: bi32.slice(0, ic * Uint32Array.BYTES_PER_ELEMENT),
        mchange: bmchange.slice(0, mc * Uint32Array.BYTES_PER_ELEMENT)
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
        return objloader(data, loader);
    }).then(obj => {
        //const v32 = makeFloat32Array(obj.attrib.vertices);
        const vi = makeVertexIndexBuffer(obj.attrib);

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
    console.log(`listening on ${port}`);
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
                        faces: d.obj.attrib.faces,
                        numFaces: d.obj.attrib.numFaces,
                        numFaceNumVerts: d.obj.attrib.numFaceNumVerts,
                        faceNumVerts: d.obj.attrib.faceNumVerts,
                        materialId: d.obj.attrib.materialId,
                        materials: mats,
                        shapes: shapes
                    };
                    writeJson(JSON.stringify(out));
                } else {
                    switch (p[1]) {
                    case "vertices":
                        writeBlob(d.vi.v32);
                        break;
                    case "indices":
                        writeBlob(d.vi.i32);
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
