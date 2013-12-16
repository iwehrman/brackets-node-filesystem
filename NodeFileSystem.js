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


/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, appshell, $, window, escape, setTimeout */

define(function (require, exports, module) {
    "use strict";
    
    var FileSystemStats     = require("filesystem/FileSystemStats"),
        FileSystemError     = require("filesystem/FileSystemError"),
        FileUtils           = require("file/FileUtils"),
        NodeConnection      = require("utils/NodeConnection");
    
    var FILE_WATCHER_BATCH_TIMEOUT = 200;   // 200ms - granularity of file watcher changes
    
    var _changeCallback,            // Callback to notify FileSystem of watcher changes
        _offlineCallback,           // Callback to notify FileSystem that watchers are offline
        _changeTimeout,             // Timeout used to batch up file watcher changes
        _pendingChanges = {};       // Pending file watcher changes
    
    var _bracketsPath   = FileUtils.getNativeBracketsDirectoryPath(),
        _modulePath     = FileUtils.getNativeModuleDirectoryPath(module),
        _nodePath       = "node/NodeFileSystemDomain",
        _domainPath     = [_bracketsPath, _modulePath, _nodePath].join("/"),
        _nodeConnection = new NodeConnection(),
        _domainsLoaded  = false;
    
    function _enqueueChange(change, needsStats) {
        _pendingChanges[change] = _pendingChanges[change] || needsStats;

        if (!_changeTimeout) {
            _changeTimeout = window.setTimeout(function () {
                if (_changeCallback) {
                    Object.keys(_pendingChanges).forEach(function (path) {
                        var needsStats = _pendingChanges[path];
                        if (needsStats) {
                            exports.stat(path, function (err, stats) {
                                if (err) {
                                    console.warn("Unable to stat changed path: ", path, err);
                                    return;
                                }
                                _changeCallback(path, stats);
                            });
                        } else {
                            _changeCallback(path);
                        }
                    });
                }
                
                _changeTimeout = null;
                _pendingChanges = {};
            }, FILE_WATCHER_BATCH_TIMEOUT);
        }
    }
    
    function _fileWatcherChange(evt, path, event, filename) {
        var change;

        if (event === "change") {
            // Only register change events if filename is passed
            if (filename) {
                // an existing file was created; stats are needed
                change = path + filename;
                _enqueueChange(change, true);
            }
        } else if (event === "rename") {
            // a new file was created; no stats are needed
            change = path;
            _enqueueChange(change, false);
        }
    }
    
    var SIMULATED_LATENCY_DELAY = -1,
        MAX_CONNECTIONS = 6;

    var _waitingRequests = [],
        _pendingRequests = {},
        _pendingRequestCount = 0,
        _requestCounter = 0;

    function _dequeueRequest() {
        if (_waitingRequests.length > 0) {
            if (_pendingRequestCount <= MAX_CONNECTIONS) {
                var request = _waitingRequests[0],
                    id = _requestCounter++;
                
                _waitingRequests.shift();
                _pendingRequestCount++;
                _pendingRequests[id] = request;
                
                setTimeout(function () {
                    request().always(function () {
                        _pendingRequestCount--;
                        delete _pendingRequests[id];
                        setTimeout(_dequeueRequest, 0);
                    });
                }, SIMULATED_LATENCY_DELAY);
                
                return true;
            }
        }
        return false;
    }
    
    function _enqueueRequest(fn) {
        _waitingRequests.push(fn);
        
        if (_waitingRequests.length > 1 || !_dequeueRequest()) {
            console.log("Delaying request: ", _waitingRequests.length, _pendingRequestCount);
        }
    }
    
    function _loadDomains() {
        return _nodeConnection
            .loadDomains(_domainPath, true)
            .done(function () {
                _domainsLoaded = true;
            });
    }
    
    var _nodeConnectionPromise = _nodeConnection.connect(true).then(_loadDomains);
    
    $(_nodeConnection).on("fileSystem.change", _fileWatcherChange);
    
    $(_nodeConnection).on("close", function (event, promise) {
        _domainsLoaded = false;
        _nodeConnectionPromise = promise.then(_loadDomains);
        
        if (_offlineCallback) {
            _offlineCallback();
        }
    });
    
    function _execWhenConnected(name, args, callback, errback) {
        function execConnected() {
            var domain = _nodeConnection.domains.fileSystem,
                fn = domain[name];

            return fn.apply(domain, args)
                .done(callback)
                .fail(errback);
        }
        
        function execConnectedWithDelay() {
            if (SIMULATED_LATENCY_DELAY > 0) {
                _enqueueRequest(execConnectedWithDelay);
            } else {
                execConnectedWithDelay();
            }
        }
        
        if (_domainsLoaded && _nodeConnection.connected()) {
            execConnected();
        } else {
            _nodeConnectionPromise
                .done(execConnected)
                .fail(errback);
        }
    }

    function _mapError(err) {
        if (!err) {
            return null;
        }
        
        switch (err) {
        case appshell.fs.ERR_INVALID_PARAMS:
            return FileSystemError.INVALID_PARAMS;
        case appshell.fs.ERR_NOT_FOUND:
            return FileSystemError.NOT_FOUND;
        case appshell.fs.ERR_CANT_READ:
            return FileSystemError.NOT_READABLE;
        case appshell.fs.ERR_CANT_WRITE:
            return FileSystemError.NOT_WRITABLE;
        case appshell.fs.ERR_UNSUPPORTED_ENCODING:
            return FileSystemError.NOT_READABLE;
        case appshell.fs.ERR_OUT_OF_SPACE:
            return FileSystemError.OUT_OF_SPACE;
        case appshell.fs.ERR_FILE_EXISTS:
            return FileSystemError.ALREADY_EXISTS;
        }
        return FileSystemError.UNKNOWN;
    }
    
    function _mapNodeError(err) {
        if (!err) {
            return FileSystemError.UNKNOWN;
        }
        
        switch (err.cause && err.cause.code) {
        case "ENOENT":
            return FileSystemError.NOT_FOUND;
        case "EEXIST":
            return FileSystemError.ALREADY_EXISTS;
        case "EPERM":
            return FileSystemError.NOT_READABLE; // ???
        default:
            console.log("Unknown node error: ", err);
            return FileSystemError.UNKNOWN;
        }
    }

    function _mapNodeStats(stats) {
        var options = {
            isFile: stats.isFile,
            mtime: new Date(stats.mtime),
            size: stats.size,
            hash: stats.mtime,
            realPath: stats.realpath
        };

        return new FileSystemStats(options);
    }
    
    function _wrap(cb) {
        return function (err) {
            var args = Array.prototype.slice.call(arguments);
            args[0] = _mapError(args[0]);
            cb.apply(null, args);
        };
    }
    
    function showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, callback) {
        appshell.fs.showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, _wrap(callback));
    }
    
    function showSaveDialog(title, initialPath, proposedNewFilename, callback) {
        appshell.fs.showSaveDialog(title, initialPath, proposedNewFilename, _wrap(callback));
    }
    
    function stat(path, callback) {
        _execWhenConnected("stat", [path],
            function (statObj) {
                callback(null, _mapNodeStats(statObj));
            }, function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function exists(path, callback) {
        _execWhenConnected("exists", [path],
            function (exists) {
                callback(null, exists);
            },
            function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function readdir(path, callback) {
        // TODO: Return stats errors
        _execWhenConnected("readdir", [path],
            function (statObjs) {
                var names = [],
                    stats = statObjs.map(function (statObj) {
                        names.push(statObj.name);
                        if (statObj.err) {
                            return _mapNodeError(statObj.err);
                        } else {
                            return _mapNodeStats(statObj);
                        }
                    });
                callback(null, names, stats);
            }, function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function mkdir(path, mode, callback) {
        if (typeof mode === "function") {
            callback = mode;
            mode = parseInt("0755", 8);
        }

        _execWhenConnected("mkdir", [path, mode],
            function (statObj) {
                callback(null, _mapNodeStats(statObj));
            }, function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function rename(oldPath, newPath, callback) {
        _execWhenConnected("rename", [oldPath, newPath],
            function () {
                callback(null);
            }, function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function strdecode(data) {
        return JSON.parse(decodeURIComponent(escape(data)));
    }

    function readFile(path, options, callback) {
        var encoding = options.encoding || "utf8";
        
        _execWhenConnected("readFile", [path, encoding],
            function (statObj) {
                var data = strdecode(statObj.data),
                    stat = _mapNodeStats(statObj);
                
                callback(null, data, stat);
            }, function (err) {
                callback(_mapNodeError(err));
            });
    }

    function readAllFiles(paths, options, callback) {
        var encoding = options.encoding || "utf8";
        
        _execWhenConnected("readAllFiles", [paths, encoding],
            function (results) {
                var mappedResults = results.map(function (obj) {
                    if (obj.err) {
                        return _mapNodeError(obj.err);
                    } else {
                        var data = strdecode(obj.data),
                            stat = _mapNodeStats(obj);
                        
                        return [data, stat];
                    }
                });
                callback(null, mappedResults);
            },
            function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function writeFile(path, data, options, callback) {
        var encoding = options.encoding || "utf8";
        
        function _finishWrite(created) {
            _execWhenConnected("writeFile", [path, data, encoding],
                function (statObj) {
                    var created = statObj.created,
                        stat = _mapNodeStats(statObj);
                    
                    callback(null, stat, created);
                }, function (err) {
                    callback(_mapNodeError(err));
                });
        }
        
        // TODO: Perform all the hash logic on the Node process
        stat(path, function (err, stats) {
            if (err) {
                switch (err) {
                case FileSystemError.NOT_FOUND:
                    _finishWrite(true);
                    break;
                default:
                    callback(err);
                }
                return;
            }
            
            if (options.hasOwnProperty("hash") && options.hash !== stats._hash) {
                console.warn("Blind write attempted: ", path, stats._hash, options.hash);
                callback(FileSystemError.CONTENTS_MODIFIED);
                return;
            }
            
            _finishWrite(false);
        });
    }
    
    function unlink(path, callback) {
        _execWhenConnected("unlink", [path],
            callback,
            function (err) {
                callback(_mapNodeError(err));
            });
    }
    
    function initWatchers(changeCallback, offlineCallback) {
        _changeCallback = changeCallback;
        _offlineCallback = offlineCallback;
    }
    
    function watchPath(path, callback) {
        callback = callback || function () {};
        
        _execWhenConnected("watchPath", [path],
                           callback.bind(undefined, null),
                           callback);
    }
    
    function unwatchPath(path, callback) {
        callback = callback || function () {};
        
        _execWhenConnected("unwatchPath", [path],
                           callback.bind(undefined, null),
                           callback);
    }
    
    function unwatchAll(callback) {
        callback = callback || function () {};
        
        _execWhenConnected("watchPath", [],
                           callback.bind(undefined, null),
                           callback);
    }
    
    // Export public API
    exports.showOpenDialog  = showOpenDialog;
    exports.showSaveDialog  = showSaveDialog;
    exports.exists          = exists;
    exports.readdir         = readdir;
    exports.mkdir           = mkdir;
    exports.rename          = rename;
    exports.stat            = stat;
    exports.readFile        = readFile;
    exports.readAllFiles    = readAllFiles;
    exports.writeFile       = writeFile;
    exports.unlink          = unlink;
    exports.initWatchers    = initWatchers;
    exports.watchPath       = watchPath;
    exports.unwatchPath     = unwatchPath;
    exports.unwatchAll      = unwatchAll;
    
    // Node only supports recursive file watching on the Darwin
    exports.recursiveWatch = appshell.platform === "mac";
    
    // Only perform UNC path normalization on Windows
    exports.normalizeUNCPaths = appshell.platform === "win";
});
