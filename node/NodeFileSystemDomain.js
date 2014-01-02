/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, node: true, nomen: true, indent: 4, maxerr: 50, bitwise: true */
/*global unescape, ArrayBuffer, Uint16Array */

"use strict";

var Promise = require("bluebird"),
    callbackfs = require("fs-extra"),
    fs = Promise.promisifyAll(callbackfs),
    isBinaryFile = require("isbinaryfile"),
    fsevents;

if (process.platform === "darwin") {
    fsevents = require("fsevents");
}

var _domainManager,
    _watcherMap = {};

function _getStatsObject(stats, realpath) {
    var obj = {
        isFile: !stats.isDirectory(),
        mtime: stats.mtime.getTime(),
        size: stats.size
    };

    if (realpath) {
        obj.realpath = realpath;
    }
    
    return obj;
}

function _getStatsBuffer(stats, realpath) {
    // 1. 8 bytes for the mtime
    // 2. 8 bytes for the size
    // 3. 2 bytes: flags
    // 3a.  the first bit indicates whether the entry is a file (1) or directory (0)
    // 3b.  the remaining 15 bits are interpreted as the length in bytes of a realpath,
    //      which may be zero
    // 4. N bytes, for some 0 <= N < 2^15, which encodes a UTF-8 realpath string
    
    var realpathBytes = realpath ? realpath.length * 2 : 0,
        fileBit = stats.isDirectory() ? 0 : 1,
        flags = (realpathBytes << 1) | fileBit,
        buffer = new Buffer(18 + realpathBytes);
    
    console.assert(realpathBytes < 32768); // 2^15
    
    buffer.writeDoubleLE(stats.mtime.getTime(), 0);
    buffer.writeDoubleLE(stats.size, 8);
    buffer.writeUInt16LE(flags, 16);
    
    var i = 0;
    for (i = 0; i < realpathBytes; i++) {
        buffer.writeUInt16LE(realpath.charCodeAt(i), (2 * i) + 18);
    }
    
    return buffer;
}

function _formatStats(encoding, stats, realpath) {
    if (encoding === null) {
        return _getStatsBuffer(stats, realpath);
    } else {
        return _getStatsObject(stats, realpath);
    }
}

function _statHelper(path, encoding) {
    var last = path.length - 1;

    if (path[last] === "/") {
        path = path.substr(0, last);
    }

    return fs.lstatAsync(path)
        .then(function (lstats) {
            if (lstats.isSymbolicLink()) {
                var pathPromise = fs.realpathAsync(path),
                    statPromise = fs.statAsync(path);
                
                return Promise.join(pathPromise, statPromise)
                    .spread(function (realpath, stats) {
                        if (stats.isDirectory() && realpath[realpath - 1] !== "/") {
                            realpath += "/";
                        }
                        
                        return _formatStats(encoding, stats, realpath);
                    });
            } else {
                return _formatStats(encoding, lstats);
            }
        });
}

function readdirCmd(path, callback) {
    fs.readdirAsync(path)
        .then(function (names) {
            var statPromises = names.map(function (name) {
                return _statHelper(path + name);
            });
            
            return Promise.settle(statPromises)
                .then(function (inspectors) {
                    return inspectors.reduce(function (total, inspector, index) {
                        if (inspector.isFulfilled()) {
                            var stats = inspector.value();
                            stats.name = names[index];
                            total.push(stats);
                        } else {
                            total.push({name: names[index], err: inspector.error()});
                        }
                        return total;
                    }, []);
                });
        })
        .nodeify(callback);
}

function _strencode(data) {
    return unescape(encodeURIComponent(JSON.stringify(data)));
}

function _readFileHelper(path, encoding) {
    var readPromise = fs.readFileAsync(path),
        statPromise = _statHelper(path, encoding);
    
    return Promise.join(readPromise, statPromise)
        .spread(function (data, stats) {
            var response;
            if (encoding === null) {
                response = Buffer.concat([stats, data], stats.length + data.length);
            } else {
                if (isBinaryFile(data, stats.size)) {
                    return Promise.rejected("Binary file");
                } else {
                    var stringData = data.toString(encoding),
                        encodedData = _strencode(stringData);
                    stats.data = encodedData;
                    response = stats;
                }
            }
            return response;
        });
}

function readFileCmd(path, encoding, callback) {
    _readFileHelper(path, encoding)
        .nodeify(callback);
}

function readAllFilesCmd(paths, encoding, callback) {
    var allPromises = paths.map(function (path) {
        return _readFileHelper(path, encoding);
    });
        
    Promise.settle(allPromises)
        .map(function (inspector) {
            var value, response;
            
            if (inspector.isFulfilled()) {
                value = inspector.value();
                
                if (encoding === null) {
                    var successHeader = new Buffer(1);
                    successHeader.writeUInt8(0, 0);
                    response = Buffer.concat([successHeader, value], value.length + 1);
                } else {
                    response = value;
                }
            } else {
                value = inspector.error();
                
                if (encoding === null) {
                    var errorHeader = new Buffer(1);
                    errorHeader.writeUInt8(1, 0); // TODO: error codes
                    response = errorHeader;
                } else {
                    response = {err: value};
                }
            }
            
            return response;
        })
        .then(function (responses) {
            if (encoding === null) {
                return Buffer.concat(responses);
            } else {
                return responses;
            }
        }, function (err) {
            console.log(err);
            throw err;
        })
        .nodeify(callback);
}

function statCmd(path, callback) {
    _statHelper(path)
        .nodeify(callback);
}

function existsCmd(path, callback) {
    callbackfs.exists(path, callback);
}

function writeFileCmd(path, data, encoding, callback) {
    existsCmd(path, function (exists) {
        fs.writeFileAsync(path, data, {encoding: encoding})
            .then(_statHelper.bind(undefined, path))
            .then(function (stats) {
                stats.created = !exists;
                return stats;
            })
            .nodeify(callback);
    });
}

function mkdirCmd(path, mode, callback) {
    fs.mkdirAsync(path, mode)
        .then(_statHelper.bind(undefined, path))
        .nodeify(callback);
}

function renameCmd(oldPath, newPath, callback) {
    fs.renameAsync(oldPath, newPath)
        .nodeify(callback);
}

function unlinkCmd(path, callback) {
    fs.removeAsync(path)
        .nodeify(callback);
}

/**
 * Un-watch a file or directory.
 * @param {string} path File or directory to unwatch.
 */
function unwatchPath(path) {
    var watcher = _watcherMap[path];

    if (watcher) {
        try {
            if (fsevents) {
                watcher.stop();
            } else {
                watcher.close();
            }
        } catch (err) {
            console.warn("Failed to unwatch file " + path + ": " + (err && err.message));
        } finally {
            delete _watcherMap[path];
        }
    }
}

/**
 * Watch a file or directory.
 * @param {string} path File or directory to watch.
 */
function watchPath(path) {
    if (_watcherMap.hasOwnProperty(path)) {
        return;
    }
    
    try {
        var watcher;
        
        if (fsevents) {
            watcher = fsevents(path);
            watcher.on("change", function (filename, info) {
                var lastIndex = filename.lastIndexOf("/") + 1,
                    parent = lastIndex && filename.substring(0, lastIndex),
                    name = lastIndex && filename.substring(lastIndex),
                    type = info.event === "modified" ? "change" : "rename";
                
                _domainManager.emitEvent("fileSystem", "change", [parent, type, name]);
            });
        } else {
            watcher = fs.watch(path, {persistent: false}, function (event, filename) {
                // File/directory changes are emitted as "change" events on the fileWatcher domain.
                _domainManager.emitEvent("fileSystem", "change", [path, event, filename]);
            });
        }

        _watcherMap[path] = watcher;
        
        watcher.on("error", function (err) {
            console.error("Error watching file " + path + ": " + (err && err.message));
            unwatchPath(path);
        });
    } catch (err) {
        console.warn("Failed to watch file " + path + ": " + (err && err.message));
    }
}

/**
 * Un-watch all files and directories.
 */
function unwatchAll() {
    var path;
    
    for (path in _watcherMap) {
        if (_watcherMap.hasOwnProperty(path)) {
            unwatchPath(path);
        }
    }
}

/**
 * Initialize the "fileSystem" domain.
 */
function init(domainManager) {
    if (!domainManager.hasDomain("fileSystem")) {
        domainManager.registerDomain("fileSystem", {major: 0, minor: 1});
    }
    
    domainManager.registerCommand(
        "fileSystem",
        "readdir",
        readdirCmd,
        true,
        "Read the contents of a directory",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the directory to read"
        }],
        [{
            name: "statObjs",
            type: "Array.<{name: string, isFile: boolean, mtime: number, size: number}>",
            description: "An array of objects, each of which contains a name and stat information"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "readFile",
        readFileCmd,
        true,
        "Read the contents of a file",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file to read"
        }, {
            name: "encoding",
            type: "string",
            description: "encoding with which to read the file"
        }],
        [{
            name: "statObjs",
            type: "{data: string, isFile: boolean, mtime: number, size: number}",
            description: "An object that contains data and stat information"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "readAllFiles",
        readAllFilesCmd,
        true,
        "Read the contents of all files",
        [{
            name: "paths",
            type: "Array.<string>",
            description: "absolute filesystem paths of the files to read"
        }, {
            name: "encoding",
            type: "string",
            description: "encoding with which to read the files"
        }],
        [{
            name: "results",
            type: "Array.<{err: string, data: string}>",
            description: "An array of objects that contain read err or file data"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "stat",
        statCmd,
        true,
        "Stat a file or directory",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file or directory to stat"
        }],
        [{
            name: "statObj",
            type: "{isFile: boolean, mtime: number, size: number, realpath: ?string}",
            description: "An object that contains stat information"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "exists",
        statCmd,
        true,
        "Determine whether a file or directory exists",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file or directory"
        }],
        [{
            name: "exists",
            type: "boolean",
            description: "A boolean that indicates whether or not the file or directory exists"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "writeFile",
        writeFileCmd,
        true,
        "Write data to a file with a given encoding",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file or directory"
        }, {
            name: "data",
            type: "string",
            description: "data to write"
        }, {
            name: "encoding",
            type: "string",
            description: "encoding with which to write the data"
        }],
        [{
            name: "statObj",
            type: "{isFile: boolean, mtime: number, size: number}",
            description: "An object that contains stat information"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "mkdir",
        mkdirCmd,
        true,
        "Create a new directory with a given mode",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the directory to create"
        }, {
            name: "mode",
            type: "number",
            description: "mode with which to create the directory"
        }],
        [{
            name: "statObj",
            type: "{isFile: boolean, mtime: number, size: number}",
            description: "An object that contains stat information for the new directory"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "rename",
        renameCmd,
        true,
        "Rename a file or directory",
        [{
            name: "oldPath",
            type: "string",
            description: "absolute filesystem path of the directory to rename"
        }, {
            name: "newPath",
            type: "string",
            description: "new absolute filesystem path"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "unlink",
        unlinkCmd,
        true,
        "Delete a file or directory",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the directory to delete"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "watchPath",
        watchPath,
        false,
        "Start watching a file or directory",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file or directory to watch"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "unwatchPath",
        unwatchPath,
        false,
        "Stop watching a file or directory",
        [{
            name: "path",
            type: "string",
            description: "absolute filesystem path of the file or directory to unwatch"
        }]
    );
    domainManager.registerCommand(
        "fileSystem",
        "unwatchAll",
        unwatchAll,
        false,
        "Stop watching all files and directories"
    );
    domainManager.registerEvent(
        "fileSystem",
        "change",
        [
            {name: "path", type: "string"},
            {name: "event", type: "string"},
            {name: "filename", type: "string"}
        ]
    );
    
    _domainManager = domainManager;
}

exports.init = init;
