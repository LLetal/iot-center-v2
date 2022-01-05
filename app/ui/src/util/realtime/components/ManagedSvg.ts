import {ManagedComponent} from '../ManagedComponent'

/**
 * transforms svg string into base64 string usable in image.src attribute
 * svg must contain xmlns="http://www.w3.org/2000/svg" attribute
 */
const svgStringToImageSrc = (text: string) =>
  `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`

const fixSvgXmlns = (text: string) =>
  /<svg .*xmlns=.*?>/.test(text)
    ? text
    : text.replace(/(<svg.*?)>/, `$1 xmlns="http://www.w3.org/2000/svg">`)

const SVG_MISSING =
  '<svg version="1.1" viewBox="0 0 90 15" xmlns="http://www.w3.org/2000/svg"><text alignment-baseline="hanging">SVG missing</text></svg>'

export class ManagedSvg extends ManagedComponent<{
  svgString: string
}> {
  private imageElement?: HTMLImageElement

  private _svgString: string = SVG_MISSING
  public get svgString(): string {
    return this._svgString
  }
  // TODO: if passed non-svg string, insert inside svg and render
  public set svgString(str: string | undefined) {
    this._svgString = fixSvgXmlns(
      str && /<svg .*?>/.test(str) ? str : SVG_MISSING
    )
    if (this.imageElement) this.update()
  }

  public setProperties(props: {svgString: string}): void {
    const str = props.svgString
    this._svgString = fixSvgXmlns(
      str && /<svg .*?>/.test(str) ? str : SVG_MISSING
    )
  }

  public update(): void {
    if (!this.imageElement) throw new Error('render not called first')
    const manager = this.manager

    const lastValues = this.keys.map((key) => ({
      key,
      value: manager.getLatestDataPoint(key)?.value,
    }))
    const svgFormated = lastValues.reduce<string>(
      (str, {key, value}) =>
        value === undefined
          ? str
          : str.replaceAll(`{${key}}`, value.toString()),
      this._svgString
    )

    const src = svgStringToImageSrc(svgFormated)

    this.imageElement.src = src
  }

  protected onDataChanged(): void {
    this.update()
  }

  protected _render(): void {
    this.imageElement = document.createElement('img')
    this.imageElement.style.width = '100%'
    this.imageElement.style.height = '100%'
    this.imageElement.style.objectFit = 'contain'
    this.element.appendChild(this.imageElement)
    this.update()
  }

  protected _destroy(): void {
    this.imageElement?.remove()
  }
}
