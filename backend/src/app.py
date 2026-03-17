from ephaptic import Ephaptic
from ephaptic.ext.fastapi import Router

from fastapi import APIRouter, FastAPI

import music

app = FastAPI(root_path='/api')

ephaptic = Ephaptic.from_app(app)

api = APIRouter(prefix='/v1')

modules = [
   music,
]

for module in modules:
    router: Router = module.router
    router.bind(ephaptic)
    api.include_router(router, prefix=f'/{module.__name__}')

app.include_router(api)

if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=8000)
