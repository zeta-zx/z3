from ephaptic.ext.fastapi import Router
from ytmusicapi import YTMusic
from typing import Optional
from .models import FilterType, SearchResult

router = Router()

ytmusic = YTMusic()

@router.get('/')
async def music_root():
    return {"status": "ok"}


@router.get('/search')
async def search(
    query: str,
    filter: Optional[FilterType] = None,
    limit: int = 20,
) -> list[SearchResult]:
    results = ytmusic.search(query, filter=(filter and filter.value) or None, limit=limit)
    return results