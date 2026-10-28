import { vi } from 'vitest'

export class ImageVisibilityObserver implements IntersectionObserver {
  static current: ImageVisibilityObserver
  readonly root = null
  readonly rootMargin = '128px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  readonly targets = new Set<Element>()
  readonly observe = (target: Element): void => {
    this.targets.add(target)
  }
  readonly unobserve = (target: Element): void => {
    this.targets.delete(target)
  }
  readonly disconnect = vi.fn(() => this.targets.clear())
  readonly takeRecords = (): IntersectionObserverEntry[] => []

  constructor(private readonly callback: IntersectionObserverCallback) {
    ImageVisibilityObserver.current = this
  }

  emit(image: Element, isIntersecting: boolean): void {
    const target = image.parentElement
    if (!target || !this.targets.has(target)) {
      throw new Error('Image is not observed')
    }
    const bounds = target.getBoundingClientRect()
    this.callback(
      [
        {
          target,
          isIntersecting,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          intersectionRatio: Number(isIntersecting),
          time: 0
        }
      ],
      this
    )
  }
}
