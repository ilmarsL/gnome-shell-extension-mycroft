/* eslint-env node */
/* eslint-disable no-sync */

import gulp from 'gulp'
import dartSass from 'sass'
import gulpSass from 'gulp-sass'
const sass = gulpSass(dartSass)


import { deleteSync } from 'del'
import { deleteAsync } from 'del'
import {execSync} from 'child_process'
import osenv from 'osenv'
import path from 'path'
import runSequence from 'run-sequence'

import eslint from 'gulp-eslint'
import threshold from 'gulp-eslint-threshold'
import jsonEditor from 'gulp-json-editor'
import shell from 'gulp-shell'
import symlink from 'gulp-symlink'
import zip from 'gulp-zip'


import metadata from './src/metadata.json' assert {type: "json"}

var paths = {
  src: [
    'src/**/*',
    '!src/**/*~',
    '!src/schemas{,/**/*}',
    '!src/metadata.json',
    '!src/.eslintrc',
  ],
  lib: [ 'lib/**/*' ],
  metadata: [ 'src/metadata.json' ],
  schemas: [ 'src/schemas/**/*' ],
  install: path.join(
    osenv.home(),
    '.local/share/gnome-shell/extensions',
    metadata.uuid
  ),
};

function getVersion(rawTag) {
  var sha1, tag;
  sha1 = execSync('git rev-parse --short HEAD').toString().replace(/\n$/, '');
  console.log('rawTag');
  console.log(rawTag);
  //for now use tag from src/metadata.json
  if (rawTag) {
    return rawTag;
  }
  
  try {
    tag = execSync('git describe --tags --exact-match ' + sha1 + ' 2>/dev/null').toString().replace(/\n$/, '');
  } catch (e) {
    return sha1;
  }  

  var v = parseInt(tag.replace(/^v/, ''), 10);
  if (isNaN(v)) {
    throw new Error('Unable to parse version from tag: ' + tag);
  }
  return v;
}

gulp.task('lint', function () {
  var thresholdWarnings = 1;
  var thresholdErrors = 1;
  return gulp.src([ '**/*.js' ])
    .pipe(eslint({
      quiet: true,
    }))
    .pipe(eslint.format())
    .pipe(threshold.afterErrors(thresholdErrors, function (numberOfErrors) {
      throw new Error('ESLint errors (' + numberOfErrors + ') equal to or greater than the threshold (' + thresholdErrors + ')');
    }))
    .pipe(threshold.afterWarnings(thresholdWarnings, function (numberOfWarnings) {
      throw new Error('ESLint warnings (' + numberOfWarnings + ') equal to or greater than the threshold (' + thresholdWarnings + ')');
    }));
});

gulp.task('sass', async function () {
  return gulp.src('sass/*.scss')
    .pipe(sass({
      errLogToConsole: true,
      outputStyle: 'expanded',
      precision: 10,
    }))
    .pipe(gulp.dest('build'));
});

gulp.task('clean', function () {
  return deleteAsync([ 'build/*/']);
});

gulp.task('copy', async function () {
  return gulp.src(paths.src)
    .pipe(gulp.dest('build'));
});
gulp.task('copy-icons', async function () {
  return gulp.src('icons/*')
    .pipe(gulp.dest('build/icons'));
});
gulp.task('copy-suggestions', async function () {
  return gulp.src('suggestions/*')
    .pipe(gulp.dest('build/suggestions'));
});
gulp.task('copy-scripts', async function () {
  return gulp.src('shellscripts/*.sh')
    .pipe(gulp.dest('build/shellscripts'));
});

gulp.task('copy-license', async function () {
  return gulp.src([ 'LICENSE' ])
    .pipe(gulp.dest('build'));
});
gulp.task('copy-release', function () {
  return gulp.src('build/**/*').pipe(gulp.dest(metadata.uuid));
});
gulp.task('metadata', async function () {
  return gulp.src(paths.metadata)
    .pipe(jsonEditor(function (json) {
      json.version = getVersion(metadata.version);
      return json;
    }, {
      end_with_newline: true,
    }))
    .pipe(gulp.dest('build'));
});

gulp.task('schemas', function(cb) {shell.task([
  'mkdir -p build/schemas',
  'glib-compile-schemas --strict --targetdir build/schemas src/schemas/',
])
cb();
});

gulp.task('build', function(cb) { gulp.series(
      'clean',
      'metadata',
      'schemas',
      'copy',
      'copy-scripts',
      'copy-icons',
      'copy-suggestions',
      'copy-license',
      'sass',  
  );
  cb();
});

gulp.task('watch', gulp.series('build', function () {
  gulp.watch(paths.src, [ 'copy' ]);
  gulp.watch(paths.lib, [ 'copy-lib' ]);
  gulp.watch('shellscripts/*.sh', [ 'copy-scripts' ]);
  gulp.watch('icons/*', [ 'copy-icons' ]);
  gulp.watch('suggestions/*', [ 'copy-suggestions' ]);
  gulp.watch(paths.metadata, [ 'metadata' ]);
  gulp.watch(paths.schemas, [ 'schemas' ]);
  gulp.watch('sass/*.scss', [ 'sass' ]);
}));


gulp.task('reset-prefs', shell.task([
  'dconf reset -f /org/gnome/shell/extensions/mycroft/',
]));

gulp.task('uninstall', async function (cb) {
  return deleteSync([ paths.install ], {
    force: true,
  }, cb);
});

gulp.task('install-link', gulp.series('uninstall', 'build' , function () {
  return gulp.src([ 'build' ])
    .pipe(symlink(paths.install));
}));


gulp.task('deploy', async function(){
  return gulp.src('build/**/*')
    .pipe(gulp.dest(paths.install));
})

gulp.task('install', gulp.series('uninstall', 'build' , 'deploy'));

gulp.task('require-clean-wd', function (cb) {
  var count = execSync('git status --porcelain | wc -l').toString().replace(/\n$/, '');
  if (parseInt(count, 10) !== 0) {
    return cb(new Error('There are uncommited changes in the working directory. Aborting.'));
  }
  return cb();
});

gulp.task('bump', function (cb) {
  var v;
  var stream = gulp.src(paths.metadata)
    .pipe(jsonEditor(function (json) {
      json.version++;
      v = 'v' + json.version;
      return json;
    }, {
      end_with_newline: true,
    }))
    .pipe(gulp.dest('src'));
  stream.on('error', cb);
  stream.on('end', function () {
    execSync('git commit src/metadata.json -m "Bump version"');
    execSync('git tag ' + v);
    return cb();
  });
});

gulp.task('push', function (cb) {
  execSync('git push origin');
  execSync('git push origin --tags');
  return cb();
});

gulp.task('dist', function (cb) {
  runSequence('build', 'copy-release', [ 'lint' ], function () {
    var zipFile = metadata.uuid + '.zip';
    var stream = gulp.src([ 'build/**/*' ])
      .pipe(zip(zipFile))
      .pipe(gulp.dest('dist'));
    stream.on('error', cb);
    stream.on('end', cb);
  });
});

gulp.task('release', gulp.series('lint', function (cb) {
  runSequence(
    'require-clean-wd',
    'bump',
    'push',
    'dist',
    cb
  );
}));

gulp.task('enable-debug', shell.task([
  'dconf write /org/gnome/shell/extensions/mycroft/debug true',
]));

gulp.task('disable-debug', shell.task([
  'dconf write /org/gnome/shell/extensions/mycroft/debug false',
]));

gulp.task('log', shell.task([
  'journalctl /usr/bin/gnome-shell -f -o cat',
]));

gulp.task('test', function (cb) {
  runSequence(
    'lint',
    cb
  );
});
gulp.task('default', function () {
  /* eslint-disable no-console, max-len */
  console.log(
    '\n' +
    'Usage: gulp [COMMAND]\n' +
    '\n' +
    'Commands\n' +
    '\n' +
    'TEST\n' +
    '  lint                  Lint source files\n' +
    '  test                  Runs the test suite\n' +
    '\n' +
    'BUILD\n' +
    '  clean                 Cleans the build directory\n' +
    '  build                 Builds the extension\n' +
    '  watch                 Builds and watches the src directory for changes\n' +
    '\n' +
    'INSTALL\n' +
    '  install               Installs the extension to\n' +
    '                        ~/.local/share/gnome-shell/extensions/\n' +
    '  install-link          Installs as symlink to build directory\n' +
    '  uninstall             Uninstalls the extension\n' +
    '  reset-prefs           Resets extension preferences\n' +
    '\n' +
    'PACKAGE\n' +
    '  dist                  Builds and packages the extension\n' +
    '  release               Bumps/tags version and builds package\n' +
    '\n' +
    'DEBUG\n' +
    '  enable-debug          Enables debug mode\n' +
    '  disable-debug         Disables debug mode\n' +
    '  log                   Show journalctl logs \n'
  );
  /* eslint-esnable no-console, max-len */
});

//exports.install = series('uninstall', 'build' , 'deploy');
