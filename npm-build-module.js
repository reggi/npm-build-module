// pass in argument for javascript file
// flag for building global module
// read the tree for dependancies
// get the dependancy versions from root package.json
// drop dependancies in module package.json
// if package.json exists only update deps

var suppress = function(){}
var dotty = require("dotty")
var path = require("path")
var _ = require("underscore")
var detective = require('detective')
var Promise = require("bluebird")
var fs = Promise.promisifyAll(require('fs-extra'))
var argv = require('minimist')(process.argv.slice(2))

var crawlDeps = require("crawl-deps")
var ensureSymlink = require("fs-ensure-symlink")
var ensureLink = require("fs-ensure-link")

if(!argv._[0]) throw new Error("need main file to build module")

var component = {}
var paths = {}

component.main = argv._[0]
component.name = path.basename(component.main, path.extname(component.main))

paths.mainFile = path.resolve(component.main)
paths.nodeModulesDir = path.resolve(path.join(paths.mainFile, "..", "node_modules"))
paths.newModuleDirDest = path.resolve(path.join(paths.mainFile, "..", "node_modules", component.name))
paths.testFile = path.resolve(path.join(paths.mainFile, "..", "test", component.main))
paths.readmeFile = path.resolve(path.join(paths.mainFile, "..", "docs", component.name+".md"))
paths.rootPackageFile = path.resolve(path.join(paths.mainFile, "..", "package.json"))
paths.buildModulesDir = path.resolve(path.join(paths.mainFile, "..", "node_modules_build"))
paths.newModuleDir = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name))
paths.newModuleTestDir = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name, "test"))
paths.newModuleTestFile = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name, "test", component.main))
paths.newModuleReadmeFile = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name, "readme.md"))
paths.newModuleMainFile = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name, component.main))
paths.newModulePackageFile = path.resolve(path.join(paths.mainFile, "..", "node_modules_build", component.name, "package.json"))

fs.existsAsync = function(path){
  return fs.openAsync(path, "r").then(function(stats){
    return true
  }).catch(function(stats){
    return false
  })
}

function createReadme(){
  return fs.existsAsync(paths.readmeFile).then(function(exists){
    if(exists){
      return ensureLink(paths.readmeFile, paths.newModuleReadmeFile)
    }else{
      return false
    }
  })
}

function createPackage(newPackage){
  return fs.existsAsync(paths.newModulePackageFile).then(function(exists){
    if(exists){
      return fs.readFileAsync(paths.newModulePackageFile, "utf8")
      .then(JSON.parse)
      .then(function(_package){
        _.extend(_package, newPackage)
        return _package
      })
      .then(function(_package){
        return fs.writeFileAsync(paths.newModulePackageFile, JSON.stringify(_package, null, 2))
      })
    }else{
      return fs.writeFileAsync(paths.newModulePackageFile, JSON.stringify(newPackage, null, 2))
    }
  })
}

function linkLocalDeps(deps){
  return Promise.map(deps, function(dep){
    var file = path.resolve(path.join(paths.mainFile, "..", dep+".js"))
    // needs to be relative build dirs if needed
    // this only works if linked moduled is in the same dir
    var newFile = path.resolve(path.join(paths.newModuleDir, dep+".js"))
    return ensureLink(file, newFile)
  })
}

function createTest(){
  return fs.existsAsync(paths.newModuleTestDir).then(function(exists){
    if(exists){
      return fs.ensureDirAsync(paths.newModuleTestDir).then(function(){
        return ensureLink(paths.testFile, paths.newModuleTestFile)
      })
    }else{
      return false
    }
  })
}

function createMain(){
  return fs.existsAsync(paths.newModuleMainFile).then(function(exists){
    if(!exists){
      return fs.linkAsync(paths.mainFile, paths.newModuleMainFile)
    }else{
      return false
    }
  })
}

function setPackageDeps(op){
  op.newPackage.dependencies = _.chain(op.deps.npm)
    .map(function(dep){
      return [dep, op.package.dependencies[dep]]
    })
    .object()
    .value()
  var missing = _.difference(op.deps.npm, _.keys(op.newPackage.dependencies))
  if(missing.length > 1) throw new Error("missing dependencies: "+ missing.join(", ")+".")
  if(missing.length == 1) throw new Error("missing dependency: "+ missing.join(", ")+".")
  return op
}

function setPackageDevDeps(op){
  if(!op.devDeps) return op
  op.newPackage.devDependencies = _.chain(op.devDeps.npm)
    .filter(function(dep){
      return !_.contains(_.keys(op.newPackage.dependencies), dep)
    })
    .map(function(dep){
      return [dep, op.package.devDependencies[dep]]
    })
    .object()
    .value()
  var allDeps = _.flatten([_.keys(op.newPackage.devDependencies), _.keys(op.newPackage.dependencies)])
  var missing = _.difference(op.devDeps.npm, allDeps)
  if(missing.length > 1) throw new Error("missing devDependencies: "+ missing.join(", ")+".")
  if(missing.length == 1) throw new Error("missing devDependency: "+ missing.join(", ")+".")
  return op
}

function newPackageDeps(){
  return Promise.props({
    "newPackage": {
      "name": component.name,
      "main": component.main
    },
    "package": fs.readFileAsync(paths.rootPackageFile, "utf8")
      .then(JSON.parse),
    "deps": crawlDeps(paths.mainFile)
      .then(crawlDeps.sort)
      .then(crawlDeps.getValues),
    "devDeps": fs.lstatAsync(paths.testFile).then(function(){
      return crawlDeps(paths.testFile)
        .then(crawlDeps.sort)
        .then(crawlDeps.getValues)
    }).catch(suppress)
  })
  .then(setPackageDeps)
  .then(setPackageDevDeps)
  .then(function(op){
    if(!op.deps) dotty.put(op, "deps.local", [])
    if(!op.devDeps) dotty.put(op, "devDeps.local", [])
    // console.log(op.newPackage)
    return createPackage(op.newPackage).then(function(){
      return linkLocalDeps(_.flatten([op.deps.local, op.devDeps.local]))
    })
  })
}

function buildModule(){
  return Promise.all([
    fs.ensureDirAsync(paths.buildModulesDir),
    fs.ensureDirAsync(paths.nodeModulesDir),
    fs.ensureDirAsync(paths.newModuleDir),
    createMain(),
    createTest(),
    createReadme(),
    newPackageDeps(),
    ensureSymlink(paths.newModuleDir, paths.newModuleDirDest)
  ])
}

buildModule()
