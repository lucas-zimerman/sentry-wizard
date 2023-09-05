/* eslint-disable max-lines */
import * as fs from 'fs';
import { Answers } from 'inquirer';
import * as _ from 'lodash';
import * as path from 'path';

import { Args } from '../../Constants';
import { exists, matchesContent, matchFiles, patchMatchingFile } from '../../Helper/File';
import { dim, green, red, yellow } from '../../Helper/Logging';
import { SentryCli } from '../../Helper/SentryCli';
import { MobileProject } from './MobileProject';

const xcode = require('xcode');

let projectPackage: any = {};

try {
  // If we run directly in setup-wizard
  projectPackage = require('../../package.json');
} catch {
  projectPackage = require(`${process.cwd()}/package.json`);
}


enum SiblingSDK {
  angular = 'angular',
  react = 'react',
  vue = 'vue'
}

export class Capacitor extends MobileProject {
  protected _answers: Answers;
  protected _sentryCli: SentryCli;

  constructor(protected _argv: Args) {
    super(_argv);
    this._sentryCli = new SentryCli(this._argv);
  }

  public async emit(answers: Answers): Promise<Answers> {
    if (this._argv.uninstall) {
      return this.uninstall(answers);
    }
    if (!(await this.shouldEmit(answers))) {
      return {};
    }

    const sentryCliProperties = this._sentryCli.convertAnswersToProperties(
      answers,
    );

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      const promises = this.getPlatforms(answers).map(
        async (platform: string) => {
          try {
            if (platform === 'ios') {
              await patchMatchingFile(
                'ios/App/*.xcodeproj/project.pbxproj',
                this._patchXcodeProj.bind(this),
              );
              dim(`✅ Patched build script in Xcode project.`);
            } else {
              await patchMatchingFile(
                '**/app/build.gradle',
                this._patchBuildGradle.bind(this),
              );
              dim(`✅ Patched build.gradle file.`);
            }
            await this._patchJsSentryInit(platform, answers);
            await this._addSentryProperties(platform, sentryCliProperties);
            dim(`✅ Added sentry.properties file to ${platform}`);

            green(`Successfully set up ${platform} for capacitor`);
          } catch (e) {
            red(e);
          }
        },
      );
      Promise.all(promises)
        .then(resolve)
        .catch(reject);
    });
  }

  public async uninstall(_answers: Answers): Promise<Answers> {
    await patchMatchingFile(
      '**/*.xcodeproj/project.pbxproj',
      this._unpatchXcodeProj.bind(this),
    );
    await patchMatchingFile(
      '**/app/build.gradle',
      this._unpatchBuildGradle.bind(this),
    );
    return {};
  }

  protected async _shouldConfigurePlatform(platform: string): Promise<boolean> {
    let result = false;

    if (!exists(`${platform}/sentry.properties`)) {
      result = true;
      this.debug(`${platform}/sentry.properties not exists`);
    }

    if (!matchesContent('**/*.xcodeproj/project.pbxproj', /sentry-cli/gi)) {
      result = true;
      this.debug('**/*.xcodeproj/project.pbxproj not matched');
    }

    if (!matchesContent('**/app/build.gradle', /sentry\.gradle/gi)) {
      result = true;
      this.debug('**/app/build.gradle not matched');
    }

    const regex = /Sentry/gi;
    if (
      exists(`index.${platform}.js`) &&
      !matchesContent(`index.${platform}.js`, regex)
    ) {
      result = true;
      this.debug(`index.${platform}.js not matched`);
    }
    if (exists('App.js') && !matchesContent('App.js', regex)) {
      result = true;
      this.debug('index.js or App.js not matched');
    }

    if (this._argv.uninstall) {
      // if we uninstall we need to invert the result so we remove already patched
      // but leave untouched platforms as they are
      return !result;
    }

    return result;
  }

  private async _patchJsSentryInit(
    platform: string,
    answers: Answers,
  ): Promise<void> {
    const prefixGlob = '{.,./src}';
    const suffixGlob = '@(j|t|cj|mj)s?(x)';
    const platformGlob = `index.${platform}.${suffixGlob}`;
    // draft for Capacitor
    const universalGlob = `app/*.module.ts`;
    //    const jsFileGlob = `${prefixGlob}/+(${platformGlob}|${universalGlob})`;
    const jsFileGlob = `${prefixGlob}/${universalGlob}`;
    const jsFileToPatch = matchFiles(jsFileGlob);
    console.log('log ' + jsFileGlob + 'end awner ' + answers + 'end platform ' + platform + 'end');
    if (jsFileToPatch.length !== 0) {
      await patchMatchingFile(
        jsFileGlob,
        this._patchJs.bind(this),
        answers,
        platform,
      );
      dim(`✅ Patched ${jsFileToPatch.join(', ')} file(s).`);
    } else {
      dim(`🚨 Could not find ${platformGlob} nor ${universalGlob} files.`);
      yellow('❓ Please, visit https://docs.sentry.io/platforms/javascript/guides/capacitor/');
    }
  }

  private _addSentryProperties(
    platform: string,
    properties: any,
  ): Promise<void> {
    let rv = Promise.resolve();

    // This will create the ios/android folder before trying to write
    // sentry.properties in it which would fail otherwise
    if (!fs.existsSync(platform)) {
      dim(`${platform} folder did not exist, creating it.`);
      fs.mkdirSync(platform);
    }
    const fn = path.join(platform, 'sentry.properties');

    if (platform === 'android' && properties['cli/executable']) {
      // We don't need to write the sentry-cli path in the properties file
      // since our gradle plugins already pick it up on the correct spot
      delete properties['cli/executable'];
    }
    rv = rv.then(() =>
      fs.writeFileSync(fn, this._sentryCli.dumpProperties(properties)),
    );

    return rv;
  }

  private _patchJs(
    contents: string,
    _filename: string,
    answers: Answers,
    platform?: string,
  ): Promise<string | null> {
    // since the init call could live in other places too, we really only
    // want to do this if we managed to patch any of the other files as well.
    if (contents.match(/Sentry.config\(/)) {
      return Promise.resolve(null);
    }

    // if we match @sentry\/capacitor somewhere, we already patched the file
    // and no longer need to
    if (contents.match('@sentry/capacitor')) {
      return Promise.resolve(contents);
    }

    let dsn = '__DSN__';
    this.getPlatforms(answers).forEach((selectedPlatform: string) => {
      if (platform && selectedPlatform === platform) {
        dsn = _.get(answers, 'config.dsn.public', null);
      } else if (platform === undefined) {
        dsn = _.get(answers, 'config.dsn.public', null);
      }
    });

    let sibling = this._getSibling();

    return Promise.resolve(
      contents.replace(
        /^([^]*)(import\s+[^;]*?;$)/m,
        match =>
          // eslint-disable-next-line prefer-template
          match +
          "\n\nimport * as Sentry from '@sentry/capacitor';\n" +
          `${this._getSiblingInclude(sibling)}\n` + "\n" +
          `Sentry.init({ \n` +
          `  dsn: '${dsn}', \n` +
          `}${this._getSiblingInit(sibling)});\n`
      ),
    );
    //TODO: On Angular, add this on @NGModule (same place where Sentry is initialized)
    /*
        {
          provide: ErrorHandler,
          useValue: SentryAngular.createErrorHandler
        },
    */
  }

  private _getSibling(): SiblingSDK | null {
    if (_.has(projectPackage, 'dependencies.@angular/core')) {
      return SiblingSDK.angular;
    }
    if (_.has(projectPackage, 'dependencies.react')) {
      return SiblingSDK.react;

    }
    if (_.has(projectPackage, 'dependencies.@vue/cli-service')) {
      return SiblingSDK.vue;
    }
    return null;
  }

  private _getSiblingInclude(sibling: SiblingSDK | null): string {
    if (sibling == SiblingSDK.angular) {
      return "import * as SentryAngular from '@sentry/angular';\n";
    }
    if (sibling == SiblingSDK.react) {
      return "import * as SentryReact from '@sentry/react';\n";

    }
    if (sibling == SiblingSDK.vue) {
      return "import * as SentryVue from '@sentry/vue';\n";

    }
    return '\n';
  }

  private _getSiblingInit(sibling: SiblingSDK | null): string {
    if (sibling == SiblingSDK.angular) {
      return ', SentryAngular.init\n';
    }
    if (sibling == SiblingSDK.react) {
      return ', SentryReact.init\n';

    }
    if (sibling == SiblingSDK.vue) {
      return ', SentryVue.init\n';
    }
    return '';
  }

  // ANDROID -----------------------------------------

  private _patchBuildGradle(contents: string): Promise<string | null> {
    // There is no sentry.gradle on sentry capacitor for now.
    return Promise.resolve(null);
    /*
        const applyFrom =
          'apply from: "../../node_modules/@sentry/capacitor/sentry.gradle"';
        if (contents.indexOf(applyFrom) >= 0) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          contents.replace(
            /^apply from: "..\/..\/node_modules\/capacitor\/capacitor.gradle"/m,
            // eslint-disable-next-line prefer-template
            match => match + '\n' + applyFrom,
          ),
        );
    */
  }

  private _unpatchBuildGradle(contents: string): Promise<string> {
    // There is no sentry.gradle on sentry capacitor for now.
    return Promise.resolve(
      contents.replace(
        /^\s*apply from: ["']..\/..\/node_modules\/@sentry\/capacitor\/sentry.gradle["'];?\s*?\r?\n/m,
        '',
      ),
    );
  }

  // IOS -----------------------------------------

  private _patchExistingXcodeBuildScripts(buildScripts: any): void {
    for (const script of buildScripts) {
      if (
        !script.shellScript.match(
          /\/scripts\/capacitor-xcode\.sh/i,
        ) ||
        script.shellScript.match(/sentry-cli\s+capacitor\s+xcode/i)
      ) {
        continue;
      }
      let code = JSON.parse(script.shellScript);
      code =
        // eslint-disable-next-line prefer-template
        'export SENTRY_PROPERTIES=sentry.properties\n' +
        'export EXTRA_PACKAGER_ARGS="--sourcemap-output $DERIVED_FILE_DIR/main.jsbundle.map"\n' +
        code.replace(
          '$CAPACITOR_XCODE',
          () =>
            // eslint-disable-next-line no-useless-escape
            '\\\"../node_modules/@sentry/cli/bin/sentry-cli capacitor xcode $CAPACITOR_XCODE\\\"',
        );
      script.shellScript = JSON.stringify(code);
    }
  }

  private _addNewXcodeBuildPhaseForSymbols(buildScripts: any, proj: any): void {
    for (const script of buildScripts) {
      if (script.shellScript.match(/sentry-cli\s+(upload-dsym|debug-files upload)/)) {
        return;
      }
    }

    proj.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      'Upload Debug Symbols to Sentry',
      null,
      {
        shellPath: '/bin/sh',
        shellScript: `
export SENTRY_PROPERTIES=sentry.properties
[[ $SENTRY_INCLUDE_NATIVE_SOURCES == "true" ]] && INCLUDE_SOURCES_FLAG="--include-sources" || INCLUDE_SOURCES_FLAG=""
../node_modules/@sentry/cli/bin/sentry-cli debug-files upload "$INCLUDE_SOURCES_FLAG"
`,
      },
    );
  }

  private _patchXcodeProj(contents: string, filename: string): Promise<string> {
    const proj = xcode.project(filename);
    return new Promise((resolve, reject) => {
      proj.parse((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        const buildScripts = [];
        for (const key in proj.hash.project.objects.PBXShellScriptBuildPhase ||
          {}) {
          if (
            // eslint-disable-next-line no-prototype-builtins
            proj.hash.project.objects.PBXShellScriptBuildPhase.hasOwnProperty(
              key,
            )
          ) {
            const val = proj.hash.project.objects.PBXShellScriptBuildPhase[key];
            if (val.isa) {
              buildScripts.push(val);
            }
          }
        }

        try {
          this._patchExistingXcodeBuildScripts(buildScripts);
        } catch (e) {
          red(e);
        }
        try {
          this._addNewXcodeBuildPhaseForSymbols(buildScripts, proj);
        } catch (e) {
          red(e);
        }

        // we always modify the xcode file in memory but we only want to save it
        // in case the user wants configuration for ios.  This is why we check
        // here first if changes are made before we might prompt the platform
        // continue prompt.
        const newContents = proj.writeSync();
        if (newContents === contents) {
          resolve();
        } else {
          resolve(newContents);
        }
      });
    });
  }

  private _unpatchXcodeBuildScripts(proj: any): void {
    const scripts = proj.hash.project.objects.PBXShellScriptBuildPhase || {};
    const firstTarget = proj.getFirstTarget().uuid;
    const nativeTargets = proj.hash.project.objects.PBXNativeTarget;

    // scripts to patch partially.  Run this first so that we don't
    // accidentally delete some scripts later entirely that we only want to
    // rewrite.
    for (const key of Object.keys(scripts)) {
      const script = scripts[key];

      // ignore comments
      if (typeof script === 'string') {
        continue;
      }

      // ignore scripts that do not invoke the capacitor-xcode command.
      if (!script.shellScript.match(/sentry-cli\s+capacitor\s+xcode/i)) {
        continue;
      }

      script.shellScript = JSON.stringify(
        JSON.parse(script.shellScript)
          // remove sentry properties export
          .replace(/^export SENTRY_PROPERTIES=sentry.properties\r?\n/m, '')
          // unwrap capacitor-xcode.sh command.  In case someone replaced it
          // entirely with the sentry-cli command we need to put the original
          // version back in.
          .replace(
            /\.\.\/\.\.\/node_modules\/@sentry\/cli\/bin\/sentry-cli\s+capacitor\s+xcode\s+\$CAPACITOR_XCODE/i,
            '$CAPACITOR_XCODE',
          ),
      );
    }

    // scripts to kill entirely.
    for (const key of Object.keys(scripts)) {
      const script = scripts[key];

      // ignore comments and keys that got deleted
      if (typeof script === 'string' || script === undefined) {
        continue;
      }

      if (
        script.shellScript.match(
          /@sentry\/cli\/bin\/sentry-cli\s+(upload-dsym|debug-files upload)\b/,
        )
      ) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete scripts[key];
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete scripts[`${key}_comment`];
        const phases = nativeTargets[firstTarget].buildPhases;
        if (phases) {
          for (let i = 0; i < phases.length; i++) {
            if (phases[i].value === key) {
              phases.splice(i, 1);
              break;
            }
          }
        }
        continue;
      }
    }
  }

  private _unpatchXcodeProj(
    _contents: string,
    filename: string,
  ): Promise<string> {
    const proj = xcode.project(filename);
    return new Promise((resolve, reject) => {
      proj.parse((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        this._unpatchXcodeBuildScripts(proj);
        resolve(proj.writeSync());
      });
    });
  }
}
