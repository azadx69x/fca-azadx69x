// fixed by @Azadx69x 
"use strict";

const { getType } = require("../utils");
const log = require("npmlog");

module.exports = function(defaultFuncs, api, ctx) {
  
  // Store loaded modules for tracking
  if (!ctx.loadedModules) {
    ctx.loadedModules = new Map();
  }

  /**
   * Validate module structure
   */
  function validateModule(moduleObj, moduleName = "unnamed") {
    if (!moduleObj) {
      throw new Error(`Module "${moduleName}" is null or undefined`);
    }

    const type = getType(moduleObj);
    if (type !== "Object") {
      throw new Error(`Module "${moduleName}" must be an object, not ${type}!`);
    }

    // Check if module has metadata
    if (moduleObj._meta) {
      const meta = moduleObj._meta;
      log.info("addExternalModule", `Loading module: ${meta.name || moduleName} v${meta.version || '1.0.0'}`);
      if (meta.description) {
        log.verbose("addExternalModule", `Description: ${meta.description}`);
      }
    }

    // Validate each export
    for (const [key, value] of Object.entries(moduleObj)) {
      // Skip metadata and private fields
      if (key.startsWith('_')) continue;

      const valueType = getType(value);
      
      if (valueType !== "Function" && valueType !== "AsyncFunction") {
        throw new Error(
          `Export "${key}" in module "${moduleName}" must be a function, not ${valueType}!`
        );
      }
    }

    return true;
  }

  /**
   * Check for naming conflicts
   */
  function checkConflicts(moduleObj, moduleName, options = {}) {
    const conflicts = [];
    const overwrite = options.overwrite || false;
    
    for (const apiName in moduleObj) {
      if (apiName.startsWith('_')) continue; // Skip private
      
      if (api[apiName] !== undefined) {
        conflicts.push(apiName);
        
        if (!overwrite) {
          log.warn("addExternalModule", 
            `API "${apiName}" already exists. Use { overwrite: true } to replace.`);
        }
      }
    }

    if (conflicts.length > 0 && !overwrite) {
      throw new Error(
        `Module "${moduleName}" conflicts with existing APIs: ${conflicts.join(', ')}. ` +
        `Use options.overwrite = true to force replace.`
      );
    }

    return conflicts;
  }

  /**
   * Initialize module function with dependency injection
   */
  function initializeFunction(fn, apiName, moduleName) {
    try {
      const initialized = fn(defaultFuncs, api, ctx);
      
      // Validate returned function
      const initType = getType(initialized);
      if (initType !== "Function" && initType !== "AsyncFunction") {
        throw new Error(
          `Module "${moduleName}" export "${apiName}" must return a function, returned ${initType}`
        );
      }

      return initialized;
      
    } catch (err) {
      log.error("addExternalModule", 
        `Failed to initialize "${apiName}" from "${moduleName}":`, err);
      throw err;
    }
  }

  /**
   * Main function to add external module
   */
  return function addExternalModule(moduleObj, options = {}) {
    const moduleName = options.name || moduleObj?._meta?.name || "unnamed_module";
    const startTime = Date.now();

    // Validate inputs
    if (!defaultFuncs || !api || !ctx) {
      throw new Error("addExternalModule: Internal API context not available");
    }

    try {
      // Step 1: Validate module structure
      validateModule(moduleObj, moduleName);

      // Step 2: Check for conflicts
      const conflicts = checkConflicts(moduleObj, moduleName, options);

      // Step 3: Load each export
      const loaded = {};
      const loadedCount = { success: 0, skipped: 0 };

      for (const apiName in moduleObj) {
        // Skip metadata and private fields
        if (apiName.startsWith('_')) continue;

        try {
          // Check if already exists and overwrite disabled
          if (api[apiName] !== undefined && !options.overwrite) {
            log.verbose("addExternalModule", `Skipping "${apiName}" (exists)`);
            loadedCount.skipped++;
            continue;
          }

          // Initialize the function
          const initializedFn = initializeFunction(
            moduleObj[apiName], 
            apiName, 
            moduleName
          );

          // Add to API
          api[apiName] = initializedFn;
          loaded[apiName] = initializedFn;
          loadedCount.success++;

          log.verbose("addExternalModule", `Loaded: ${apiName}`);

        } catch (initErr) {
          if (options.continueOnError) {
            log.error("addExternalModule", 
              `Failed to load "${apiName}", continuing...`, initErr);
            loadedCount.skipped++;
          } else {
            throw initErr;
          }
        }
      }

      // Step 4: Store module info
      const moduleInfo = {
        name: moduleName,
        loadedAt: new Date().toISOString(),
        exports: Object.keys(loaded),
        conflicts: conflicts,
        options: options,
        loadTime: Date.now() - startTime
      };

      ctx.loadedModules.set(moduleName, moduleInfo);

      // Step 5: Call onLoad hook if exists
      if (moduleObj._onLoad && getType(moduleObj._onLoad) === "Function") {
        try {
          moduleObj._onLoad(defaultFuncs, api, ctx, loaded);
        } catch (hookErr) {
          log.warn("addExternalModule", `Module "${moduleName}" onLoad hook failed:`, hookErr);
        }
      }

      log.info("addExternalModule", 
        `Module "${moduleName}" loaded successfully (${loadedCount.success} exports, ${loadedCount.skipped} skipped) in ${moduleInfo.loadTime}ms`);

      return {
        success: true,
        module: moduleName,
        loaded: Object.keys(loaded),
        skipped: loadedCount.skipped,
        conflicts: conflicts,
        info: moduleInfo
      };

    } catch (err) {
      log.error("addExternalModule", `Failed to load module "${moduleName}":`, err);
      throw err;
    }
  };
};
