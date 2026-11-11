import {withRequest} from './node.js';
import {createFetchAdapters} from './fetch-adapters.js';
export const {svelteKitHandle, astroMiddleware, honoMiddleware} = createFetchAdapters(withRequest);
