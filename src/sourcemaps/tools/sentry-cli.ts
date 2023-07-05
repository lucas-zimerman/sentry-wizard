// @ts-ignore - clack is ESM and TS complains about that. It works though
import clack from '@clack/prompts';
import chalk from 'chalk';
import * as Sentry from '@sentry/node';
import * as path from 'path';
import * as fs from 'fs';
import {
  abortIfCancelled,
  addSentryCliRc,
  getPackageDotJson,
  hasPackageInstalled,
  installPackage,
} from '../../utils/clack-utils';

import { SourceMapUploadToolConfigurationOptions } from './types';

export async function configureSentryCLI(
  options: SourceMapUploadToolConfigurationOptions,
  configureSourcemapGenerationFlow: () => Promise<void> = defaultConfigureSourcemapGenerationFlow,
): Promise<void> {
  const packageDotJson = await getPackageDotJson();

  await installPackage({
    packageName: '@sentry/cli',
    alreadyInstalled: hasPackageInstalled('@sentry/cli', packageDotJson),
  });

  let validPath = false;
  let relativeArtifactPath;
  do {
    const rawArtifactPath = await abortIfCancelled(
      clack.text({
        message: 'Where are your build artifacts located?',
        placeholder: `.${path.sep}out`,
        validate(value) {
          if (!value) {
            return 'Please enter a path.';
          }
        },
      }),
    );

    if (path.isAbsolute(rawArtifactPath)) {
      relativeArtifactPath = path.relative(process.cwd(), rawArtifactPath);
    } else {
      relativeArtifactPath = rawArtifactPath;
    }

    try {
      await fs.promises.access(path.join(process.cwd(), relativeArtifactPath));
      validPath = true;
    } catch {
      validPath = await abortIfCancelled(
        clack.select({
          message: `We couldn't find artifacts at ${relativeArtifactPath}. Are you sure that this is the location that contains your build artifacts?`,
          options: [
            {
              label: 'No, let me verify.',
              value: false,
            },
            { label: 'Yes, I am sure!', value: true },
          ],
          initialValue: false,
        }),
      );
    }
  } while (!validPath);

  const relativePosixArtifactPath = relativeArtifactPath
    .split(path.sep)
    .join(path.posix.sep);

  await configureSourcemapGenerationFlow();

  packageDotJson.scripts = packageDotJson.scripts || {};
  packageDotJson.scripts['sentry:ci'] = `sentry-cli sourcemaps inject --org ${
    options.orgSlug
  } --project ${
    options.projectSlug
  } ${relativePosixArtifactPath} && sentry-cli${
    options.selfHosted ? ` --url ${options.url}` : ''
  } sourcemaps upload --org ${options.orgSlug} --project ${
    options.projectSlug
  } ${relativePosixArtifactPath}`;

  await fs.promises.writeFile(
    path.join(process.cwd(), 'package.json'),
    JSON.stringify(packageDotJson, null, 2),
  );

  clack.log.info(
    `Added a ${chalk.cyan('sentry:ci')} script to your ${chalk.cyan(
      'package.json',
    )}. Make sure to run this script ${chalk.bold(
      'after',
    )} building your application but ${chalk.bold('before')} deploying!`,
  );

  const addedToCI = await abortIfCancelled(
    clack.select({
      message: `Did you add a step to your CI pipeline that runs the ${chalk.cyan(
        'sentry:ci',
      )} script ${chalk.bold('right after')} building your application?`,
      options: [
        { label: 'Yes, continue!', value: true },
        {
          label: "I'll do it later...",
          value: false,
          hint: chalk.yellow(
            'You need to run the command after each build for source maps to work properly.',
          ),
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag('added-ci-script', addedToCI);

  if (!addedToCI) {
    clack.log.info("Don't forget! :)");
  }

  await addSentryCliRc(options.authToken);
}

async function defaultConfigureSourcemapGenerationFlow(): Promise<void> {
  await abortIfCancelled(
    clack.select({
      message: `Verify that your build tool is generating source maps. ${chalk.dim(
        '(Your build output folder should contain .js.map files after a build)',
      )}`,
      options: [{ label: 'I checked. Continue!', value: true }],
      initialValue: true,
    }),
  );
}
