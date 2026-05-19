import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';

const doStaticBuild = process.env.BUILD_ENV === 'static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: doStaticBuild 
			? adapterStatic({
				fallback: 'index.html',
				strict: false
			})
			: adapterNode()
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) => filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
