from ephaptic.ext.fastapi import Router

from ytmusicapi import YTMusic

router = Router()

ytmusic = YTMusic()

@router.get('/')
async def music_root():
    return {"status": "ok"}


@router.get('/search')
async def search(query: str):
    results = ytmusic.search(query)
    return results