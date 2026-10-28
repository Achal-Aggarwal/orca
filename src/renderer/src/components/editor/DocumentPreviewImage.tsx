import { useEffectEvent, useLayoutEffect, useRef, type ComponentProps } from 'react'
import { createDocumentImageDisplay, type DocumentImageSource } from './document-image-display'

type DocumentPreviewImageProps = Omit<ComponentProps<'img'>, 'src'> & DocumentImageSource

export function DocumentPreviewImage({
  src,
  filePath,
  runtimeContext,
  access,
  resolvedSrc,
  ...props
}: DocumentPreviewImageProps): React.JSX.Element {
  const elementRef = useRef<HTMLSpanElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const displayRef = useRef<ReturnType<typeof createDocumentImageDisplay> | null>(null)
  const readSource = useEffectEvent(() => ({ src, filePath, runtimeContext, access, resolvedSrc }))

  useLayoutEffect(() => {
    const element = elementRef.current
    const image = imageRef.current
    if (!element || !image) {
      return
    }
    const display = createDocumentImageDisplay(element, image, readSource())
    displayRef.current = display
    return () => {
      display.destroy()
      displayRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    displayRef.current?.update(readSource())
  })

  return (
    <span ref={elementRef} style={{ display: 'inline-block', maxWidth: '100%' }}>
      <img {...props} ref={imageRef} />
    </span>
  )
}
