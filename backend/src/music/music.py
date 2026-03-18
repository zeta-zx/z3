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
async def music_search(
    query: str,
    filter: Optional[FilterType] = None,
    limit: int = 20,
) -> list[SearchResult]:
    results = ytmusic.search(query, filter=(filter and filter.value) or None, limit=limit)
    return results

@router.get('/search/suggestions')
async def music_search_suggestions(
    query: str,
) -> list[str]:
    results = ytmusic.get_search_suggestions(query)
    return results