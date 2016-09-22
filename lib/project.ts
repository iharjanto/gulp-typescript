import * as stream from 'stream';
import * as ts from 'typescript';
import * as vfs from 'vinyl-fs';
import * as path from 'path';
import * as through2 from 'through2';
import * as gutil from 'gulp-util';
import * as utils from './utils';
import { Reporter, defaultReporter } from './reporter';
import { FileCache } from './input';
import { Output } from './output';
import { ICompiler, ProjectCompiler, FileCompiler } from './compiler';
import { TsConfig, VinylFile } from './types';

interface PartialProject {
	(reporter?: Reporter): ICompileStream;

	src?(this: Project): NodeJS.ReadWriteStream;

	typescript?: typeof ts;
	projectDirectory?: string;
	config?: TsConfig;
	options?: ts.CompilerOptions;
}
export interface Project {
	(reporter?: Reporter): ICompileStream;

	src(this: Project): NodeJS.ReadWriteStream;

	readonly typescript?: typeof ts;
	readonly projectDirectory: string;
	readonly config: TsConfig;
	readonly options: ts.CompilerOptions;
}

export interface ProjectInfo {
	input: FileCache;
	output: Output;
	compiler: ICompiler;
	singleOutput: boolean;
	options: ts.CompilerOptions;
	typescript: typeof ts;
	reporter: Reporter;
}

export function setupProject(projectDirectory: string, config: TsConfig, options: ts.CompilerOptions, typescript: typeof ts) {
	const input = new FileCache(typescript, options);
	const compiler: ICompiler = options.isolatedModules ? new FileCompiler() : new ProjectCompiler();
	let running = false;

	if (options.isolatedModules) {
		options.newLine = ts.NewLineKind.LineFeed;
		options.sourceMap = false;
		options.declaration = false;
		options.inlineSourceMap = true;
	}

	const project: PartialProject = (reporter) => {
		if (running) {
			throw new Error('gulp-typescript: A project cannot be used in two compilations at the same time. Create multiple projects with createProject instead.');
		}
		running = true;

		input.reset();
		compiler.prepare(projectInfo);

		const stream = new CompileStream(projectInfo);
		projectInfo.output = new Output(projectInfo, stream, stream.js, stream.dts);
		projectInfo.reporter = reporter || defaultReporter;

		stream.on('finish', () => {
			running = false;
		});

		return stream;
	};

	const singleOutput = options.out !== undefined || options.outFile !== undefined;

	project.src = src;
	project.typescript = typescript;
	project.projectDirectory = projectDirectory;
	project.config = config;
	project.options = options;
	
	const projectInfo: ProjectInfo = {
		input,
		singleOutput,
		compiler,
		options,
		typescript,
		// Set when `project` is called
		output: undefined,
		reporter: undefined
	};

	return project as Project;
}

function src(this: Project) {
	let base: string;
	if (this.options["rootDir"]) {
		base = path.resolve(this.projectDirectory, this.options["rootDir"]);
	}

	const content: any = {};
	if (this.config.include) content.include = this.config.include;
	if (this.config.exclude) content.exclude = this.config.exclude;
	if (this.config.files) content.files = this.config.files;
	if (this.options['allowJs']) content.compilerOptions = { allowJs: true };
	const { fileNames, errors } = this.typescript.parseJsonConfigFileContent(
		content,
		this.typescript.sys,
		this.projectDirectory);

	for (const error of errors) {
		console.log(error.messageText);
	}

	if (base === undefined) base = utils.getCommonBasePathOfArray(
		fileNames.filter(file => file.substr(-5) !== ".d.ts")
			.map(file => path.dirname(file)));

	const vinylOptions = { base, allowEmpty: true };
	return vfs.src(fileNames, vinylOptions);
}

export interface ICompileStream extends NodeJS.ReadWriteStream {
	js: stream.Readable;
	dts: stream.Readable;
}
class CompileStream extends stream.Duplex implements ICompileStream {
	constructor(project: ProjectInfo) {
		super({objectMode: true});

		this.project = project;

		// Prevent "Unhandled stream error in pipe" when a compilation error occurs.
		this.on('error', () => {});
	}

	private project: ProjectInfo;

	_write(file: any, encoding, cb: (err?) => void);
	_write(file: VinylFile, encoding, cb = (err?) => {}) {
		if (!file) return cb();

		if (file.isNull()) {
			cb();
			return;
		}
		if (file.isStream()) {
			return cb(new gutil.PluginError('gulp-typescript', 'Streaming not supported'));
		}

		const inputFile = this.project.input.addGulp(file);

		this.project.compiler.inputFile(inputFile);

		cb();
	}
	_read() {

	}

	end(chunk?, encoding?, callback?) {
		if (typeof chunk === 'function') {
			this._write(null, null, chunk);
		} else if (typeof encoding === 'function') {
			this._write(chunk, null, encoding);
		} else {
			this._write(chunk, encoding, callback);
		}
		this.project.compiler.inputDone();
	}

	js: stream.Readable = new CompileOutputStream();
	dts: stream.Readable = new CompileOutputStream();
}
class CompileOutputStream extends stream.Readable {
	constructor() {
		super({objectMode: true});
	}

	_read() {

	}
}
