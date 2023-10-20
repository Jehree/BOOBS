/* eslint-disable @typescript-eslint/brace-style */
import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { ITemplateItem } from "@spt-aki/models/eft/common/tables/ITemplateItem";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { IDatabaseTables } from "@spt-aki/models/spt/server/IDatabaseTables";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";

import * as config from "../config/config.json";
import * as ammoBoxesJson from "../config/box info/ammoboxes.json";
import * as ammoTiersJson from "../config/configs/ammotiers.json";
import * as ammoTiersRealismJson from "../config/realism configs/ammotiers_realism.json";
import * as ammoWeightsJson from "../config/configs/weights.json";
import * as ammoWeightsRealismJson from "../config/realism configs/weights_realism.json";

class Mod implements IPostDBLoadMod
{
    public postDBLoad(container: DependencyContainer): void {

        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const lg = container.resolve<ILogger>("WinstonLogger")
        const jsonUtil = container.resolve<JsonUtil>("JsonUtil")
        const dbTables = databaseServer.getTables();
        const dbLocations = dbTables.locations

        this.pushAmmoBoxesToDB(dbTables, jsonUtil, lg)

        for (const mapKey in dbLocations){

            const thisMapLooseLoot =  dbTables.locations[mapKey]?.looseLoot?.spawnpoints
            if (thisMapLooseLoot === undefined) continue

            const itemWeights = this.getItemWeights()

            this.setMapAmmoSpawns(thisMapLooseLoot, itemWeights, dbTables, lg)
        }
    }

    pushAmmoBoxesToDB(dbTables, jsonUtil, lg){

        const dbHandbook = dbTables.templates.handbook;
        const locales = Object.values(dbTables.locales.global) as Record<string, string>[];

        const configAmmoBoxes = ammoBoxesJson.BOXES
        const configAmmoTiers = ammoTiersJson.CALIBERS
        for (const caliber in configAmmoBoxes){

            const thisCaliber = configAmmoBoxes[caliber]
            if (configAmmoTiers[caliber].type === "GRENADES_UGL_FLARES") continue

            for (const boxId in thisCaliber){

                const thisConfigBox = thisCaliber[boxId]
                if (thisConfigBox.disabled) continue
                if (thisConfigBox.box_type === undefined){
                    lg.log("CHECK ammoboxes.json FILE FOR MISSING OR MISPELLED box_type", "red")
                    continue
                }

                const ammoBox = this.createAmmoBox(jsonUtil, dbTables, thisConfigBox, boxId)           
                dbTables.templates.items[boxId] = ammoBox

                dbHandbook.Items.push(
                    {
                        "Id": boxId,
                        "ParentId": "5b47574386f77428ca22b33c",
                        "Price": 0
                    }
                );

                for (const locale of locales) {
                    locale[`${boxId} Name`] = `Carboard box holding ${locale[`${thisConfigBox.roundInBox_id} Name`]} rounds`
                    locale[`${boxId} ShortName`] = locale[`${thisConfigBox.roundInBox_id} ShortName`]
                    locale[`${boxId} Description`] = `Carboard box holding ${locale[`${thisConfigBox.roundInBox_id} Name`]} rounds`
                }
            }
        }
    }

    createAmmoBox(jsonUtil, dbTables, configBox, boxId):any{

        const roundInBoxId = configBox.roundInBox_id
        const boxType = configBox.box_type ?? "DEFAULT"

        const newBox = jsonUtil.clone(dbTables.templates.items["5737330a2459776af32363a1"])
        newBox._id = boxId

        newBox._name = boxId
        newBox._props.Name = boxId
        newBox._props.ShortName = boxId
        newBox._props.Description = boxId

        newBox._props.Width = config.box_types[boxType].sizeH ?? 1
        newBox._props.Height = config.box_types[boxType].sizeV ?? 1
        
        newBox._props.StackSlots[0]._parent = boxId
        newBox._props.StackSlots[0]._props.filters[0].Filter = [roundInBoxId]
        newBox._props.StackSlots[0]._max_count = configBox.round_count

        const bundlePath = config.box_types[boxType].bundle_path
        newBox._props.Prefab.path = bundlePath

        return newBox
    }

    getItemWeights(){

        const itemWeights = {}

        let ammoWeights
        if (config.spt_realism_ammo_compat){
            ammoWeights = ammoWeightsRealismJson.CATEGORIES
        } else {
            ammoWeights = ammoWeightsJson.CATEGORIES
        }


        let ammoTiers
        if (config.spt_realism_ammo_compat){
            ammoTiers = ammoTiersRealismJson.CALIBERS
        } else {
            ammoTiers = ammoTiersJson.CALIBERS
        }

        for (const cal in ammoTiers){

            const thisWeightCatKey = ammoTiers[cal].type ?? "GENERAL"
            const thisCatWeights = ammoWeights[thisWeightCatKey]

            const caliberWeightMultipliers = ammoWeights["CALIBERS"]
            const thisCalTiers = ammoTiers[cal]
            
            //get sum of multiplier numbers from this tier
            const summedCatMultipliers = +(+Object.values(thisCatWeights).reduce((init:number, iter:number) => init + iter, 0)).toFixed(4)
            
            //all cals start with a weight of 1200 that gets multiplied by their respective cal multiplier
            const calTotalAllottedWeight = 1200 * caliberWeightMultipliers[cal]
            
            /* formuala below (thanks chatGPT!)
            share_A = (m_A / total_multiplier) * totalPointsForCategory
            share_B = (m_B / total_multiplier) * totalPointsForCategory
            share_C = (m_C / total_multiplier) * totalPointsForCategory
            share_D = (m_D / total_multiplier) * totalPointsForCategory
            */

            for (const tier in thisCalTiers){

                const dontLoopTheseParams = ["type", "box_type"]
                if (!dontLoopTheseParams.includes(tier)){

                    const thisTierMultiplier = thisCatWeights[tier]
                    const thisTierAlottedWeight = (thisTierMultiplier / summedCatMultipliers) * calTotalAllottedWeight

                    //loop thru this tier's ammos and divide the alloted weight we calc'd among them
                    //then add that to the itemWeights object
                    const thisTierArr = thisCalTiers[tier]
                    for (const i in thisTierArr){
                        itemWeights[thisTierArr[i]] = Math.round(thisTierAlottedWeight / thisTierArr.length)
                    }
                }
            }
        }
        return itemWeights
    }

    setMapAmmoSpawns(mapLootSpawnpoints, itemWeights, dbTables: IDatabaseTables, lg):void{

        const ammoBoxes = ammoBoxesJson.BOXES
        const ammoTiers = ammoTiersJson.CALIBERS
        const dbItems = dbTables.templates.items
        
        for (const loot in mapLootSpawnpoints){
            const thisSpawnPoint = mapLootSpawnpoints[loot]
            const thisSpawnPointTemplate = thisSpawnPoint.template
            thisSpawnPoint.probability *= ammoWeightsJson.GLOBAL_AMMO_SPAWN_CHANCE_MULTI


            for (const item in thisSpawnPointTemplate?.Items){
                //if this spawn point has an ammo box
                

                if (dbItems[thisSpawnPointTemplate.Items[item]?._tpl]?._parent === "543be5cb4bdc2deb348b4568"){

                    thisSpawnPointTemplate.Items = []
                    thisSpawnPoint.itemDistribution = []
    
                    for (const cal in ammoBoxes){
    
                        const thisCal = ammoBoxes[cal]

                        if (ammoTiers[cal]?.type === "GRENADES_UGL_FLARES"){
                            for (const nadeOrFlare in thisCal){

                                if (itemWeights[nadeOrFlare] === undefined){
                                    lg.log("CHECK JSONS FOR MISPELLED AMMO!!", "red")
                                }
                                
                                thisSpawnPointTemplate.Items.push(
                                    {
                                        _id: nadeOrFlare + "SpawnPointItemID",
                                        _tpl: thisCal[nadeOrFlare]
                                    }
                                )
                                thisSpawnPoint.itemDistribution.push(
                                    {
                                        composedKey: {
                                            key: nadeOrFlare + "SpawnPointItemID"
                                        },
                                        relativeProbability: itemWeights[nadeOrFlare] ?? 1
                                    }
                                )
                            }
                        }  else {
                            for (const ammoBoxId in thisCal){
                                
                                if (!thisCal[ammoBoxId].disabled){

                                    if (itemWeights[thisCal[ammoBoxId].roundInBox_name] === undefined)
                                        lg.log("CHECK JSONS FOR MISPELLED AMMO!!", "red")

                                    thisSpawnPointTemplate.Items.push(
                                        {
                                            _id: thisCal[ammoBoxId].roundInBox_name + "SpawnPointItemID",
                                            _tpl: ammoBoxId                                        
    
                                        },
                                        {
                                            _id: thisCal[ammoBoxId].roundInBox_name + "ChildSpawnPointItemID",
                                            _tpl: thisCal[ammoBoxId].roundInBox_id,                                        
                                            parentId: thisCal[ammoBoxId].roundInBox_name + "SpawnPointItemID",
                                            slotId: "cartridges",
                                            upd: {StackObjectsCount:thisCal[ammoBoxId].round_count}
                                        }
                                    )

                                    thisSpawnPoint.itemDistribution.push(
                                        {
                                            composedKey: {
                                                key: thisCal[ammoBoxId].roundInBox_name + "SpawnPointItemID"
                                            },
                                            relativeProbability: itemWeights[thisCal[ammoBoxId].roundInBox_name] ?? 1
                                        }
                                    )
                                }
                            }
                        }
                    }
                    /*console.log(thisSpawnPointTemplate.Items)
                    console.log(thisSpawnPoint.itemDistribution)*/

                    //break
                }
            }
        }
    }

    logAmmoAndBoxes(lg: ILogger, dbItems: Record<string, ITemplateItem>, nameContains){
        lg.log("All rounds and ammo boxes for this caliber: " + nameContains, "magenta")

        const ammosOfThisCal = []

        for (const item in dbItems){
            if (dbItems[item]._parent === "5485a8684bdc2da71d8b4567" && dbItems[item]._name.includes(nameContains)){
            
                ammosOfThisCal.push(item)
            }
        }

        for (const item in dbItems){
            if (dbItems[item]._parent === "543be5cb4bdc2deb348b4568" && dbItems[item]._name.includes(nameContains)){

                const roundInBox = dbItems[item]._props.StackSlots[0]._props.filters[0].Filter[0]
                const roundCount = dbItems[item]._props.StackSlots[0]._max_count

                lg.log(`"${item}":{
                    "roundInBox_id": "${roundInBox}",
                    "roundInBox_name": "${dbItems[roundInBox]._name}",
                    "round_count": ${roundCount},
                    "box_name": "${dbItems[item]._name}"
                },`, "green")

                for (let i = ammosOfThisCal.length-1; i >= 0; i--){
                    if (roundInBox.includes(ammosOfThisCal[i])){
                        ammosOfThisCal.splice(i, 1)
                    }
                }
                
            }
        }

        for (const ammo in ammosOfThisCal){
            lg.log(`"${dbItems[ammosOfThisCal[ammo]]._name}_jehree_ammobox":{
                "roundInBox_id": "${ammosOfThisCal[ammo]}",
                "roundInBox_name": "${dbItems[ammosOfThisCal[ammo]]._name}",
                "round_count": 30,
                "boxIsNew": true
            },`, "yellow")
        }

        lg.log("Rounds that have no box: " + ammosOfThisCal, "red")
    }
}

module.exports = { mod: new Mod() }